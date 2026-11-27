import { mapWithConcurrency } from "./data-reliability";
import { parseDatedClientType } from "./official-details";
import type { MarketHighlight } from "./market";

/**
 * Weekly real-money inflow for the highlights tab.
 *
 * The daily card only keeps the last session's real-money values, so the five
 * closed sessions are rebuilt from the same official endpoints the rest of the
 * page uses: one daily-price list per symbol (it carries several sessions) and
 * one dated ClientType record per symbol and session. The last session is
 * already in the daily card and is never requested again; every other closed
 * session is cached in the browser per instrument+date, so a later visit only
 * asks for sessions that were not recorded yet.
 */
export const WEEKLY_SESSIONS = 5;
/** Sessions kept in the browser cache; older ones are pruned. */
export const WEEKLY_CACHE_SESSIONS = 10;
export const WEEKLY_CACHE_KEY = "ss-weekly-real-money-v1";

const TSETMC_BASE = "https://cdn.tsetmc.com/api";
const RELAY = "/api/tsetmc-relay?path=";
const CONCURRENCY = 6;
// Direct CDN reads send only Accept: Referer is a forbidden browser header and
// User-Agent makes the request preflighted.
const TSETMC_HEADERS = { Accept: "application/json, text/plain, */*" };

const faCount = new Intl.NumberFormat("fa-IR", { useGrouping: false });

/** «۳ از ۵ جلسه» when a symbol did not fill the whole window. */
export function weeklyCoverageLabel(covered: number, total = WEEKLY_SESSIONS): string | null {
  return covered < total ? `${faCount.format(Math.max(0, covered))} از ${faCount.format(total)} جلسه` : null;
}

export type WeeklySessionNet = { date: number; net: number | null };

/** Sum of the sessions that have a value; missing sessions stay missing, never zero. */
export function weeklySummary(values: (number | null)[]): {
  net: number | null; covered: number; coverageLabel: string | null;
} {
  const available = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return {
    net: available.length ? available.reduce((sum, value) => sum + value, 0) : null,
    covered: available.length,
    coverageLabel: weeklyCoverageLabel(available.length),
  };
}

// ─── Browser cache ──────────────────────────────────────────────────────────
/** One recorded closed session: the net real-money value in Rial. */
export type WeeklyCacheEntry = { net: number };
export type WeeklyCache = Record<string, WeeklyCacheEntry>;

const cacheKeyOf = (insCode: string, date: number) => `${insCode}:${date}`;
const dateOfKey = (key: string) => Number(key.split(":")[1]);

export function readWeeklyCache(): WeeklyCache {
  if (typeof window === "undefined") return {};
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(WEEKLY_CACHE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const cache: WeeklyCache = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      const net = Number((value as WeeklyCacheEntry | null)?.net);
      if (/^\S+:\d{8}$/.test(key) && Number.isFinite(net)) cache[key] = { net };
    }
    return cache;
  } catch { return {}; }
}

export function writeWeeklyCache(cache: WeeklyCache): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(WEEKLY_CACHE_KEY, JSON.stringify(cache)); } catch { /* storage full or blocked */ }
}

/** Keep only the newest `keep` session dates; a closed session is stored once. */
export function pruneWeeklyCache(cache: WeeklyCache, keep = WEEKLY_CACHE_SESSIONS): WeeklyCache {
  const dates = [...new Set(Object.keys(cache).map(dateOfKey).filter((date) => Number.isFinite(date) && date > 0))]
    .sort((a, b) => b - a).slice(0, Math.max(1, keep));
  const allowed = new Set(dates);
  const pruned: WeeklyCache = {};
  for (const [key, value] of Object.entries(cache)) if (allowed.has(dateOfKey(key))) pruned[key] = value;
  return pruned;
}

// ─── Official reads ─────────────────────────────────────────────────────────
export type TradedSession = { date: number; close: number | null; volume: number | null };

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const positive = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const parsed = num(row[key]);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
};

/**
 * Traded sessions of a daily-price list, newest first. A record without a
 * price or volume is a non-trading day for the symbol and does not use a slot.
 */
export function parseTradedSessions(payload: unknown, limit = WEEKLY_SESSIONS): TradedSession[] {
  const rows = (payload as { closingPriceDaily?: unknown } | null)?.closingPriceDaily;
  if (!Array.isArray(rows)) return [];
  const byDate = new Map<number, TradedSession>();
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const date = num(row.dEven);
    if (!date) continue;
    const close = positive(row, ["pClosing", "pcl", "close"]);
    const volume = positive(row, ["qTotTran5J", "qtj", "volume"]);
    if (close === null || volume === null) continue;
    byDate.set(date, { date, close, volume });
  }
  return [...byDate.values()].sort((a, b) => b.date - a.date).slice(0, Math.max(1, limit));
}

async function readTsetmc(path: string, signal: AbortSignal | undefined, request: typeof fetch): Promise<unknown> {
  try {
    const direct = await request(`${TSETMC_BASE}/${path}`, { headers: TSETMC_HEADERS, signal });
    if (direct.ok) return await direct.json();
  } catch { /* the relay is the fallback for a blocked direct route */ }
  const relayed = await request(`${RELAY}${encodeURIComponent(path)}`, { signal });
  if (!relayed.ok) throw new Error(`TSETMC ${relayed.status}`);
  return relayed.json();
}

/** Net real-money value of one closed session, in Rial; null when unpublished and unpriceable. */
function sessionNet(record: Record<string, unknown>, close: number | null): number | null {
  const buyValue = num(record.buy_I_Value);
  const sellValue = num(record.sell_I_Value);
  if (buyValue !== null && sellValue !== null) return buyValue - sellValue;
  const buyVolume = num(record.buy_I_Volume);
  const sellVolume = num(record.sell_I_Volume);
  if (buyVolume !== null && sellVolume !== null && close !== null) return (buyVolume - sellVolume) * close;
  return null;
}

export type WeeklySymbolResult = {
  symbol: string;
  insCode: string;
  net: number;
  covered: number;
  coverageLabel: string | null;
  /** Session dates used, newest first. */
  dates: number[];
};

export type WeeklyLoadOptions = {
  /** Rows of the dominant session — exactly the symbols the daily card ranks. */
  rows: MarketHighlight[];
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  onUpdate?: (rows: WeeklySymbolResult[], done: number, total: number) => void;
};

function latestNetFromDailyCard(row: MarketHighlight): number | null {
  if (row.realBuyValue !== null && row.realBuyValue !== undefined && row.realSellValue !== null && row.realSellValue !== undefined) {
    return row.realBuyValue - row.realSellValue;
  }
  if (Number.isFinite(row.realBuyVolume) && Number.isFinite(row.realSellVolume) && row.priceClose > 0) {
    return (row.realBuyVolume - row.realSellVolume) * row.priceClose;
  }
  return null;
}

/**
 * Load the weekly inflow for `options.rows`. Each symbol makes at most one
 * price request and one ClientType request per closed session that is not
 * cached; the last session is read from the daily card instead.
 */
export async function loadWeeklyInflow(options: WeeklyLoadOptions): Promise<WeeklySymbolResult[]> {
  const request = options.fetchImpl ?? fetch;
  const cache = pruneWeeklyCache(readWeeklyCache());
  const total = options.rows.length;
  const results: WeeklySymbolResult[] = [];
  let done = 0;

  await mapWithConcurrency(options.rows, CONCURRENCY, async (row) => {
    if (options.signal?.aborted || !row.insCode) return;
    const latest = row.sessionDate ?? null;
    let sessions: TradedSession[] = [];
    try {
      sessions = parseTradedSessions(await readTsetmc(
        `ClosingPrice/GetClosingPriceDailyList/${encodeURIComponent(row.insCode)}/12`, options.signal, request));
    } catch { sessions = []; }
    // The card's own session may be newer than the daily list and is authoritative.
    if (latest && !sessions.some((session) => session.date === latest)) {
      sessions = [{ date: latest, close: row.priceClose > 0 ? row.priceClose : null, volume: null }, ...sessions]
        .sort((a, b) => b.date - a.date).slice(0, WEEKLY_SESSIONS);
    }
    sessions = sessions.slice(0, WEEKLY_SESSIONS);

    const values: number[] = [];
    const used: number[] = [];
    for (const session of sessions) {
      if (options.signal?.aborted) break;
      let net: number | null = null;
      const isCardSession = session.date === latest && row.clientTypeDate === latest;
      if (isCardSession) net = latestNetFromDailyCard(row);
      if (net === null) {
        const key = cacheKeyOf(row.insCode, session.date);
        const cached = cache[key];
        if (cached) net = cached.net;
        else {
          try {
            const typed = parseDatedClientType(
              await readTsetmc(`ClientType/GetClientTypeHistory/${encodeURIComponent(row.insCode)}/${session.date}`, options.signal, request),
              row.insCode, session.date);
            if (typed) {
              net = sessionNet(typed as Record<string, unknown>, session.close);
              if (net !== null) cache[key] = { net };
            }
          } catch { /* one missing session keeps the symbol with fewer sessions */ }
        }
      }
      if (net !== null) { values.push(net); used.push(session.date); }
    }

    const summary = weeklySummary(values);
    if (summary.net !== null) {
      results.push({
        symbol: row.symbol, insCode: row.insCode, net: summary.net,
        covered: summary.covered, coverageLabel: summary.coverageLabel, dates: used,
      });
    }
    done += 1;
    options.onUpdate?.([...results], done, total);
  });

  writeWeeklyCache(pruneWeeklyCache(cache));
  return results;
}

/** Descending by weekly inflow, best ten — the same shape as the other cards. */
export function rankWeeklyInflow(rows: WeeklySymbolResult[], limit = 10): WeeklySymbolResult[] {
  return [...rows].filter((row) => row.net > 0).sort((a, b) => b.net - a.net).slice(0, limit);
}
