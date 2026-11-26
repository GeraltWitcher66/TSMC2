import { mapWithConcurrency } from "./data-reliability";
import type { IndustryRow } from "./industry";
import { aggregateIndustrySymbols, type MarketQuote, type SymbolFlow } from "./industry-symbols";

/**
 * Back-filling the multi-session industry card.
 *
 * The published industry feed has no history, so previous sessions are rebuilt
 * from TSETMC per-symbol history: one daily-price list per symbol (it returns
 * several sessions at once) plus one ClientType record per symbol and session.
 * Requests run at most six at a time and the caller keeps the result, so the
 * sweep happens once per session and never on every refresh.
 */
const TSETMC_BASE = "https://cdn.tsetmc.com/api";
const RELAY = "/api/tsetmc-relay?path=";
const CONCURRENCY = 6;
const TSETMC_HEADERS = {
  Accept: "application/json, text/plain, */*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Referer: "https://tsetmc.com/",
};

export type HistorySymbol = { insCode: string; symbol: string; name: string; sectorCode: string };
export type BackfillProgress = { phase: "prices" | "flows"; done: number; total: number };
export type BackfillOptions = {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  concurrency?: number;
  onProgress?: (progress: BackfillProgress) => void;
  /** Sessions already recorded by the daily card; skipped in the sweep. */
  excludeDates?: number[];
  /** How many earlier sessions the card still needs. */
  needed: number;
};

type PriceRow = { date: number; close: number | null; prevClose: number | null; value: number | null; volume: number | null };

const numberOrNull = (value: unknown) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Daily rows use `pClosing`/`qTotCap`/`qTotTran5J`, but the CDN also serves
 * the same figures as `pcl`/`qtc`/`qtj`; zero means "not set" in both shapes. */
const positiveFirst = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const parsed = numberOrNull(row[key]);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
};

/** Direct CDN first, then the Worker relay, so one blocked route does not end the sweep. */
async function readTsetmc(path: string, options: BackfillOptions): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(`${TSETMC_BASE}/${path}`, { headers: TSETMC_HEADERS, signal: options.signal });
    if (response.ok) return await response.json();
  } catch { /* fall through to the relay */ }
  const relay = await fetchImpl(`${RELAY}${encodeURIComponent(path)}`, { signal: options.signal });
  if (!relay.ok) throw new Error(`TSETMC ${relay.status}`);
  return await relay.json();
}

/** One request per symbol covers every session in the list. */
async function readPriceRows(symbol: HistorySymbol, options: BackfillOptions): Promise<PriceRow[]> {
  const payload = await readTsetmc(`ClosingPrice/GetClosingPriceDailyList/${encodeURIComponent(symbol.insCode)}/12`, options);
  const rows = (payload as { closingPriceDaily?: unknown } | null)?.closingPriceDaily;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const date = numberOrNull(row.dEven);
    if (!date) return [];
    return [{
      date,
      close: positiveFirst(row, ["pClosing", "pcl", "close"]),
      prevClose: positiveFirst(row, ["priceYesterday", "py", "yesterday"]),
      value: positiveFirst(row, ["qTotCap", "qtc", "value"]),
      volume: positiveFirst(row, ["qTotTran5J", "qtj", "volume"]),
    }];
  });
}

function readFlows(payload: unknown): SymbolFlow | null {
  const item = (payload as { clientType?: Record<string, unknown> } | null)?.clientType;
  if (!item || typeof item !== "object") return null;
  const pick = (keys: string[]) => {
    for (const key of keys) {
      const value = numberOrNull(item[key]);
      if (value !== null) return value;
    }
    return null;
  };
  return {
    buyVolume: pick(["buy_I_Volume", "buyIVolume"]),
    sellVolume: pick(["sell_I_Volume", "sellIVolume"]),
    buyValue: pick(["buy_I_Value", "buyIValue"]),
    sellValue: pick(["sell_I_Value", "sellIValue"]),
    buyCount: pick(["buy_CountI", "buy_I_Count", "buyCountI"]),
    sellCount: pick(["sell_CountI", "sell_I_Count", "sellCountI"]),
  };
}

/**
 * Rebuild the last `needed` sessions that the daily card has not recorded yet.
 * A session without any usable symbol produces no row, never a zero-filled one.
 */
export async function backfillIndustryHistory(
  symbols: HistorySymbol[],
  sectorNames: Record<string, string>,
  options: BackfillOptions,
): Promise<{ date: number; rows: IndustryRow[] }[]> {
  const excluded = new Set(options.excludeDates ?? []);
  if (!symbols.length || options.needed <= 0) return [];
  const concurrency = Math.max(1, Math.min(options.concurrency ?? CONCURRENCY, 8));

  const prices = new Map<string, PriceRow[]>();
  let priceDone = 0;
  await mapWithConcurrency(symbols, concurrency, async (symbol) => {
    if (options.signal?.aborted) return;
    try { prices.set(symbol.insCode, await readPriceRows(symbol, options)); }
    catch { prices.set(symbol.insCode, []); }
    priceDone += 1;
    options.onProgress?.({ phase: "prices", done: priceDone, total: symbols.length });
  });

  // The market calendar is shared, so the union of returned dates is the session list.
  const sessions = [...new Set([...prices.values()].flatMap((rows) => rows.map((row) => row.date)))]
    .filter((date) => !excluded.has(date))
    .sort((a, b) => b - a)
    .slice(0, options.needed);
  if (!sessions.length) return [];

  const pairs = symbols.flatMap((symbol) => {
    const rows = prices.get(symbol.insCode) ?? [];
    return sessions.flatMap((date) => {
      const price = rows.find((row) => row.date === date);
      return price && price.value !== null && price.value > 0 ? [{ symbol, date, price }] : [];
    });
  });

  const flowsByDate = new Map<number, Map<string, SymbolFlow>>(sessions.map((date) => [date, new Map()]));
  let flowDone = 0;
  await mapWithConcurrency(pairs, concurrency, async (pair) => {
    if (options.signal?.aborted) return;
    try {
      const payload = await readTsetmc(
        `ClientType/GetClientTypeHistory/${encodeURIComponent(pair.symbol.insCode)}/${pair.date}`, options);
      const flow = readFlows(payload);
      if (flow) flowsByDate.get(pair.date)?.set(pair.symbol.insCode, flow);
    } catch { /* a single missing instrument keeps its industry total incomplete, not zero */ }
    flowDone += 1;
    options.onProgress?.({ phase: "flows", done: flowDone, total: pairs.length });
  });

  return sessions.flatMap((date) => {
    const quotes: MarketQuote[] = pairs.filter((pair) => pair.date === date).map(({ symbol, price }) => ({
      insCode: symbol.insCode,
      symbol: symbol.symbol,
      name: symbol.name,
      sectorCode: symbol.sectorCode,
      close: price.close,
      last: price.close,
      prevClose: price.prevClose,
      value: price.value,
      volume: price.volume,
      changePct: price.close !== null && price.prevClose !== null && price.prevClose > 0
        ? ((price.close - price.prevClose) / price.prevClose) * 100 : null,
    }));
    const { rows } = aggregateIndustrySymbols(quotes, flowsByDate.get(date) ?? new Map(), sectorNames);
    return rows.length ? [{ date, rows }] : [];
  });
}

/** Latest sessions seen in a symbol's price history, newest first (used by tests and callers). */
export function latestSessions(prices: PriceRow[][], limit = 3): number[] {
  return [...new Set(prices.flatMap((rows) => rows.map((row) => row.date)))].sort((a, b) => b - a).slice(0, limit);
}
