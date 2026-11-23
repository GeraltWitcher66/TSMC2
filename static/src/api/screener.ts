import {
  calculateValuationMetrics,
  candleFromInstrument,
  mergeCandlesByDate,
  normalizeSymbol,
  latestMarketDate,
  parseTsetmcDailyHistory,
  type ScreenerRow,
  type ShareChange,
  sixMonthCutoff,
  toApiSymbol,
  type Candle,
} from "../../../app/lib/market";
import { mapWithConcurrency } from "../../../app/lib/data-reliability";
import { datedCurrentQuotes, QUOTE_BATCH_SIZE } from "../../../app/lib/current-quotes";
import { recalculateScreenerRow } from "../../../app/lib/screener-analysis";
import { fetchTsetmcViaHosts } from "./relay";
import { upstreamJson, type UpstreamDiagnostic } from "../../../app/lib/upstream";
import { isClosedScreenerSession, sourceDailyNoTrade, sourceSession, validSourceDailyPrice } from "../../../app/lib/market-session";
import { lastClosedEquitySession } from "../../../app/lib/market-session";
import { summarizeScreenerFreshness } from "../../../app/lib/screener-freshness";
import { jsonResponse, readJsonBody } from "./json";

const DATA_BASE = "https://zarvanfund.ir/api";
const TSETMC_SHARE_CHANGE = "https://cdn.tsetmc.com/api/Instrument/GetInstrumentShareChange";
const TSETMC_DAILY_HISTORY = "https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList";
const MAX_OFFICIAL_HISTORY_SYMBOLS = 4;
const MAX_CAPITAL_ACTION_LOOKUPS = 12;
// The list UI abandons a base-only request after 18s and then recovers in the
// browser. An upstream attempt exceeding that window only wastes work and can
// surface as an empty batch instead of a JSON answer.
export const BASE_ONLY_FEED_TIMEOUTS = { instruments: 8_000, daily: 12_000 } as const;

type Instrument = Record<string, unknown>;

/** Zarvan candles carry trade counters and values not used by any
 * 90/180/RSI/divergence function. Keep only the Candle contract before
 * analysis so the browser holds and serializes far smaller histories. */
export function compactScreenerCandle(raw: Candle): Candle {
  const result: Candle = { d_even: raw.d_even, high: raw.high, close: raw.close };
  if (raw.low !== undefined) result.low = raw.low;
  if (raw.last !== undefined) result.last = raw.last;
  if (raw.open !== undefined) result.open = raw.open;
  if (raw.yesterday !== undefined) result.yesterday = raw.yesterday;
  return result;
}

const chunks = <T,>(items: T[], size: number) => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

async function fetchJson(url: string, timeoutMs = 25_000) {
  return upstreamJson(url, { timeoutMs });
}

// Official TSETMC history enrichment: direct fetch first; if the network
// cannot reach the CDN, rotate through the official hosts.
async function getOfficialCandles(insCode: string) {
  try {
    const payload = await fetchJson(`${TSETMC_DAILY_HISTORY}/${encodeURIComponent(insCode)}/1000?_=${Date.now()}`, 6_000);
    return parseTsetmcDailyHistory(payload);
  } catch {
    try {
      const body = await fetchTsetmcViaHosts(`ClosingPrice/GetClosingPriceDailyList/${insCode}/1000`);
      return body ? parseTsetmcDailyHistory(JSON.parse(body)) : [];
    } catch {
      return [];
    }
  }
}

function hasPotentialAdjustmentGap(candles: Candle[], earliestDate: number) {
  const ordered = [...candles].sort((a, b) => a.d_even - b.d_even);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (current.d_even < earliestDate || !previous.close) continue;
    // A missing yesterday is not evidence that prices are continuous. A
    // sufficiently large close break merits optional official verification.
    const hasReference = Number.isFinite(current.yesterday) && current.yesterday! > 0;
    const reference = hasReference ? current.yesterday! : current.close;
    if (Number.isFinite(reference) && reference > 0 &&
        Math.abs(reference / previous.close - 1) >= (hasReference ? 0.08 : 0.16)) return true;
  }
  return false;
}

function instrumentField(item: Instrument | undefined, ...keys: string[]) {
  for (const key of keys) if (item?.[key] !== undefined && item[key] !== null) return item[key];
  return undefined;
}

function parseShareChanges(payload: unknown): ShareChange[] {
  const root = payload as Record<string, unknown> | null;
  const candidates = Array.isArray(payload)
    ? payload
    : Object.values(root ?? {}).find(Array.isArray) ?? [];
  if (!Array.isArray(candidates)) return [];
  return candidates.flatMap((raw) => {
    const item = raw as Record<string, unknown>;
    const date = Number(item.dEven ?? item.DEven ?? item.date ?? 0);
    const oldShares = Number(item.numberOfShareOld ?? item.NumberOfShareOld ?? item.oldShares ?? 0);
    const newShares = Number(item.numberOfShareNew ?? item.NumberOfShareNew ?? item.newShares ?? 0);
    return date && oldShares > 0 && newShares > oldShares ? [{ date, oldShares, newShares }] : [];
  });
}

async function getOfficialChanges(insCode: string) {
  try {
    return parseShareChanges(await fetchJson(`${TSETMC_SHARE_CHANGE}/${encodeURIComponent(insCode)}`, 3_000));
  } catch {
    return [];
  }
}

export async function screenerRequest(
  _url: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const receivedAt = Date.now();
  try {
    const body = await readJsonBody<{ symbols?: string[]; baseOnly?: boolean }>(init);
    if (!Array.isArray(body?.symbols) || body.symbols.length > QUOTE_BATCH_SIZE || body.symbols.some((symbol) => typeof symbol !== "string")) return jsonResponse({ error: `هر درخواست باید حداکثر ${QUOTE_BATCH_SIZE} نماد معتبر داشته باشد.` }, 400);
    const symbols = Array.from(new Set(body.symbols.map(normalizeSymbol).filter(Boolean)));
    if (!symbols.length) return jsonResponse({ error: "حداقل یک نماد لازم است." }, 400);

    const apiSymbols = symbols.map(toApiSymbol);
    const debug: string[] = [];
    const diagnostics: UpstreamDiagnostic[] = [];
    const observe = (event: UpstreamDiagnostic) => { diagnostics.push(event); };
    const baseOnly = body.baseOnly === true;
    // Fetch independent base feeds together; never queue metadata behind a slow history.
    const instrumentPromise = upstreamJson<Record<string, Instrument>>(`${DATA_BASE}/instruments?syms=${encodeURIComponent(apiSymbols.join(","))}`, {
      timeoutMs: baseOnly ? BASE_ONLY_FEED_TIMEOUTS.instruments : 12_000, signal, observe,
      validate: value => Boolean(value && typeof value === "object" && !Array.isArray(value)),
    }).catch(() => ({} as Record<string, Instrument>));
    const candleResponses = await Promise.all(chunks(apiSymbols, 40).map(async (part) => {
      const url = `${DATA_BASE}/daily-batch?limit=260&syms=${encodeURIComponent(part.join(","))}&_=${Date.now()}`;
      try {
        const result = await upstreamJson<Record<string, Candle[]>>(url, { timeoutMs: baseOnly ? BASE_ONLY_FEED_TIMEOUTS.daily : 25_000, signal, observe,
          validate: value => Boolean(value && typeof value === "object" && !Array.isArray(value)),
        });
        debug.push(`candles OK for ${part.length} syms`);
        return result;
      } catch (err) {
        debug.push(`candles FAIL: ${err instanceof Error ? err.message : String(err)}`);
        return {};
      }
    }));
    const candleMap = new Map<string, Candle[]>();
    const rejectedDates = new Map<string, number>();
    const rejectedNoTrade = new Map<string, number>();
    for (const response of candleResponses) for (const [key, value] of Object.entries(response)) {
      const symbol = normalizeSymbol(key);
      if (!symbols.includes(symbol) || !Array.isArray(value)) continue;
      rejectedDates.set(symbol, value.filter(row => !sourceSession(row?.d_even)).length);
      // A provider can pre-create a dated slot for a halted/non-traded symbol.
      // Explicit zero/invalid volume is evidence against a traded candle,
      // and must not advance the displayed last-trade date to "today".
      // Missing volume is distinguished from proven zero for legacy feeds.
      rejectedNoTrade.set(symbol, value.filter(sourceDailyNoTrade).length);
      candleMap.set(symbol, value
        .filter(row => validSourceDailyPrice(row))
        .map(compactScreenerCandle));
    }

    const instrumentResponses = [await instrumentPromise];
    const instrumentMap = new Map<string, Instrument>();
    for (const response of instrumentResponses) {
      for (const [key, value] of Object.entries(response)) if (symbols.includes(normalizeSymbol(key))) instrumentMap.set(normalizeSymbol(key), value);
    }

    // Price similarity cannot prove a trading date (holidays and halted symbols
    // break that inference). Only a source-dated candle may extend history.
    for (const symbol of symbols) {
      const instrument = instrumentMap.get(symbol);
      const current = candleFromInstrument(instrument);
      if (current && isClosedScreenerSession(current.d_even)) {
        candleMap.set(symbol, mergeCandlesByDate([current], candleMap.get(symbol) ?? []));
        continue;
      }
    }

    // Official history is a bounded enrichment for small requests only.
    // Large refreshes use bounded browser batches to respect rate limits.
    let officialMerged = 0;
    if (!baseOnly && symbols.length <= MAX_OFFICIAL_HISTORY_SYMBOLS) {
      const officialResults = await mapWithConcurrency(symbols, 4, async (symbol) => {
        const instrument = instrumentMap.get(symbol);
        const insCode = String(instrumentField(instrument, "InsCode", "ins_code", "insCode") ?? "");
        return { symbol, candles: insCode ? await getOfficialCandles(insCode) : [] };
      });
      for (const result of officialResults) {
        if (!result.candles.length) continue;
        candleMap.set(result.symbol, mergeCandlesByDate(result.candles, candleMap.get(result.symbol) ?? []));
        officialMerged += 1;
      }
    }

    // A dated official current quote takes priority over daily history for
    // the same session. Twenty-symbol batches leave room for action checks.
    const currentQuotes = baseOnly ? new Map<string, Record<string, unknown>>() : await datedCurrentQuotes(instrumentMap, observe);
    const unverifiedCurrent = new Set<string>();
    for (const symbol of symbols) {
      const quote = currentQuotes.get(symbol);
      const current = quote ? candleFromInstrument(quote) : null;
      const existing = candleMap.get(symbol) ?? [];
      const latestSourceDate = Math.max(0, ...existing.map(candle => candle.d_even));
      // A dated Zarvan instrument snapshot is still Zarvan, NOT independently
      // verified TSETMC data. An official quote for an older session cannot
      // verify the latest source-dated candle either.
      if (current && isClosedScreenerSession(current.d_even) && current.d_even >= latestSourceDate) {
        candleMap.set(symbol, mergeCandlesByDate([current], existing));
      } else {
        unverifiedCurrent.add(symbol);
      }
    }

    // Base-only requests must remain bounded beneath the list client's 18s
    // deadline. An extra twelve sequentially throttled official lookups after
    // the history fetch could push a 20-symbol request over that deadline.
    // Missing official confirmation is handled conservatively by analysis
    // (unresolved gap/unknown return); browser official enrichment runs later.
    const changeResults = new Map<string, ShareChange[]>();
    const gapCandidates = (baseOnly ? [] : symbols)
      .filter((symbol) => {
        const candles = candleMap.get(symbol) ?? [];
        if (!candles.length) return false;
        const newest = Math.max(...candles.map((item) => item.d_even));
        return hasPotentialAdjustmentGap(candles, sixMonthCutoff(newest));
      })
      .slice(0, MAX_CAPITAL_ACTION_LOOKUPS);
    const officialChanges = await mapWithConcurrency(gapCandidates, 3, async (symbol) => {
      const instrument = instrumentMap.get(symbol);
      const insCode = String(instrumentField(instrument, "InsCode", "ins_code", "insCode") ?? "");
      return { symbol, changes: insCode ? await getOfficialChanges(insCode) : [] };
    });
    for (const result of officialChanges) changeResults.set(result.symbol, result.changes);

    const feedsReadyAt = Date.now();
    const rows: ScreenerRow[] = symbols.map((symbol) => {
      const candles = candleMap.get(symbol) ?? [];
      const instrument = instrumentMap.get(symbol);
      if (!candles.length) return {
        symbol, insCode: String(instrumentField(instrument, "InsCode", "insCode", "ins_code") ?? ""), rsi: null, realHolders: null, three: null, six: null, actions: [], status: "error",
        note: diagnostics.some(e => e.path.includes("daily-batch") && e.code !== "OK") ? "درخواست سابقه قیمت ناموفق بود؛ نبود داده در منبع تأیید نشده است." : rejectedNoTrade.get(symbol) ? "رکوردهای جدیدتر بدون معاملهٔ معتبر ثبت شده‌اند؛ تاریخ آخرین معامله قابل تأیید نیست." : rejectedDates.get(symbol) ? "تاریخ سابقهٔ قیمت معتبر نیست." : "پاسخ منبع برای این نماد سابقهٔ قیمت معتبر نداشت.",
      };
      const changes = changeResults.get(symbol) ?? [];
      const name = String(instrumentField(instrument, "Name", "name") ?? "");
      const insCode = String(instrumentField(instrument, "InsCode", "insCode", "ins_code") ?? "");
      const latestCandle = [...candles].sort((a, b) => b.d_even - a.d_even)[0];
      const valuation = calculateValuationMetrics(
        Number(latestCandle?.close ?? 0),
        Number(instrumentField(instrument, "Eps", "EPS", "EstimatedEPS", "estimatedEPS") ?? 0),
        Number(instrumentField(instrument, "Pe", "PE", "pe") ?? 0),
        Number(instrumentField(instrument, "SectorPE", "SectorPe", "sectorPE", "sectorPe") ?? 0),
      );
      const row: ScreenerRow = {
        symbol, name, insCode, rsi: null, realHolders: null,
        three: null, six: null, actions: [],
        valuation,
        analysisInput: { candles, changes, eps: valuation.eps, pe: valuation.pe, sectorPe: valuation.sectorPe },
        status: "ready",

      };
      return recalculateScreenerRow(row, candles, changes, !unverifiedCurrent.has(symbol));
    });
    const calculatedAt = Date.now();

    // This is the latest market session, not the most common per-symbol date.
    // The latter becomes stale whenever many selected symbols are halted or a
    // fallback provider is behind the official feed.
    const latestDate = latestMarketDate(candleMap.values());
    debug.push(`datedQuotes=${currentQuotes.size}, officialHistory=${officialMerged}, capitalChecks=${gapCandidates.length}, latest=${latestDate}`);
    const computedCount = rows.filter(row => row.three || row.six).length;
    const pricedCount = rows.filter(row => row.priceQuote || row.three || row.six).length;
    const freshness = summarizeScreenerFreshness(rows, lastClosedEquitySession());
    return jsonResponse(
      { rows, latestDate, fetchedAt: new Date().toISOString(),
        source: baseOnly ? "Zarvan dated base feeds (official verification deferred)" : "Zarvan dated feeds + optional TSETMC verification",
        officialVerification: baseOnly ? "deferred-to-browser" : "attempted-where-eligible",
        partial: computedCount < symbols.length || diagnostics.some(event => event.code !== "OK"),
        debug, diagnostics, freshness,
        coverage: { requested: symbols.length, computed: computedCount, quoted: pricedCount,
          missingPrices: symbols.length - pricedCount, missingMetrics: symbols.length - computedCount,
          rejectedDates: [...rejectedDates.values()].reduce((a,b) => a+b,0),
          rejectedNoTrade: [...rejectedNoTrade.values()].reduce((a,b) => a+b,0) },
        outcomes: rows.map(row => ({ symbol: row.symbol, insCode: row.insCode || null,
          date: row.priceQuote?.sessionDate ?? row.three?.currentDate ?? null,
          price: row.priceQuote || row.three || row.six ? "received" : "unavailable",
          metrics: row.three || row.six ? "available" : "withheld",
          reason: row.note ?? null, rejectedDates: rejectedDates.get(row.symbol) ?? 0,
          rejectedNoTrade: rejectedNoTrade.get(row.symbol) ?? 0 })),
      },
      200,
      {
        "Server-Timing": `market_feeds;dur=${feedsReadyAt - receivedAt},market_analysis;dur=${calculatedAt - feedsReadyAt}`,
      },
    );
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "دریافت داده بیش از حد طول کشید؛ دوباره تلاش کن."
      : `دریافت داده‌ی بازار ناموفق بود${error instanceof Error ? ` (${error.message})` : ""}.`;
    return jsonResponse({ error: message }, 502);
  }
}
