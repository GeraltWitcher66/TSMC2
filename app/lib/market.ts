import { analyzeDivergence, type DivergenceOptions, type DayOverDayDivergence, type DivergenceAnalysis } from "./divergence";
import { instrumentSession, lastClosedEquitySession, selectHolderSession } from "./market-session";
export { analyzeDivergence, DIVERGENCE_DEFAULTS } from "./divergence";
export type { DayOverDayDivergence, DivergenceOptions, DivergenceAnalysis } from "./divergence";

export type Candle = {
  close: number;
  d_even: number;
  high: number;
  last?: number;
  low?: number;
  open?: number;
  yesterday?: number;
};

/** Reject impossible Gregorian session dates; Date.UTC otherwise normalizes them. */
const validGregorianDate = (value: number) => {
  if (!Number.isInteger(value) || value < 19000101 || value > 29991231) return false;
  const year = Math.floor(value / 10000), month = Math.floor(value / 100) % 100, day = value % 100;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
};

// TSETMC's compact history endpoint returns rows as:
// date@high@low@close@last@open@yesterday@value@volume@tradeCount
export function parseTsetmcTradeHistory(payload: string): Candle[] {
  const byDate = new Map<number, Candle>();
  const closedSession = lastClosedEquitySession();
  for (const rawRow of payload.trim().split(";")) {
    if (!rawRow) continue;
    const rawFields = rawRow.split("@");
    const fields = rawFields.map(Number);
    const [d_even, high, low, close, last, open, yesterday] = fields;
    if (!validGregorianDate(d_even) || d_even > closedSession) continue;
    if (![high, low, close].every(Number.isFinite) ||
        close <= 0 || high <= 0 || low <= 0 || low > close || close > high) continue;
    // The source may create a dated daily slot without any trades.
    // An omitted volume is unknown, but an explicit zero is not evidence of
    // a traded closing price.
    if (rawFields[8]?.trim() && (!Number.isFinite(fields[8]) || fields[8] <= 0)) continue;
    byDate.set(d_even, {
      d_even,
      high,
      low,
      close,
      last: Number.isFinite(last) ? last : undefined,
      open: Number.isFinite(open) ? open : undefined,
      yesterday: Number.isFinite(yesterday) ? yesterday : undefined,
    });
  }
  return [...byDate.values()].sort((a, b) => b.d_even - a.d_even);
}

// TSETMC's current CDN endpoint returns the same history as structured JSON.
// Keep this parser strict so a malformed upstream response cannot replace a
// valid fallback history with unusable rows.
export function parseTsetmcDailyHistory(payload: unknown): Candle[] {
  const root = payload as Record<string, unknown> | null;
  const rows = root?.closingPriceDaily;
  if (!Array.isArray(rows)) return [];

  const byDate = new Map<number, Candle>();
  const closedSession = lastClosedEquitySession();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const item = raw as Record<string, unknown>;
    const d_even = Number(item.dEven ?? item.d_even ?? 0);
    const high = Number(item.priceMax ?? item.high ?? 0);
    const low = Number(item.priceMin ?? item.low ?? 0);
    const close = Number(item.pClosing ?? item.close ?? 0);
    if (!validGregorianDate(d_even) || d_even > closedSession) continue;
    if (![high, low, close].every(Number.isFinite) ||
        close <= 0 || high <= 0 || low <= 0 || low > close || close > high) continue;
    const tradedVolume = item.qTotTran5J ?? item.volume;
    if (tradedVolume !== undefined && tradedVolume !== null &&
        (!Number.isFinite(Number(tradedVolume)) || Number(tradedVolume) <= 0)) continue;
    const optionalNumber = (value: unknown) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    byDate.set(d_even, {
      d_even,
      high,
      low,
      close,
      last: optionalNumber(item.pDrCotVal ?? item.last),
      open: optionalNumber(item.priceFirst ?? item.open),
      yesterday: optionalNumber(item.priceYesterday ?? item.yesterday),
    });
  }
  return [...byDate.values()].sort((a, b) => b.d_even - a.d_even);
}

/** An undated quote cannot identify a market session, even if volume is positive. */
export function candleFromInstrument(instrument: Record<string, unknown> | undefined): Candle | null {
  if (!instrument) return null;
  const d_even = instrumentSession(instrument);
  const high = Number(instrument.PriceMax);
  const low = Number(instrument.PriceMin);
  const close = Number(instrument.PriceClose);
  if (!d_even) return null;
  if (![high, low, close].every((value) => Number.isFinite(value) && value > 0) ||
      low > close || close > high) return null;
  if (!Number.isFinite(Number(instrument.Volume)) || Number(instrument.Volume) <= 0) return null;
  const optionalNumber = (value: unknown) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : undefined;
  return { d_even, high, low, close, last: optionalNumber(instrument.PriceLast), open: optionalNumber(instrument.PriceFirst), yesterday: optionalNumber(instrument.PriceYesterday) };
}

const nextTradingDayCompact = (compact: number) => {
  const source = dateFromCompact(compact);
  // Walk forward at most 4 calendar days (Thu+Fri weekend + holidays buffer).
  for (let step = 1; step <= 4; step += 1) {
    const candidate = new Date(source.getTime() + step * 86_400_000);
    const weekday = candidate.getUTCDay(); // 4 = Thursday, 5 = Friday
    if (weekday !== 4 && weekday !== 5) return compactDate(candidate);
  }
  return null;
};

/**
 * Zarvan's live instruments snapshot often carries a fully settled new session
 * (price fields updated) while its Date field stays 0 — and TSETMC can be
 * unreachable from the Worker at that moment, so without this the UI would
 * keep showing the previous session as "newest". We only stamp the snapshot
 * as a new candle when the chain proves it is one:
 *   1. the snapshot's PriceYesterday equals the last settled candle's close
 *      (its "previous session" is our newest candle), and
 *   2. its OHLC differ from that close (not a restatement of the same day), and
 *   3. the inferred day's candle is already closed by Tehran market clock
 *      (never during live trading hours), and
 *   4. the inferred day is within one trading day of the last candle.
 */
export function candleFromUndatedInstrument(
  instrument: Record<string, unknown> | undefined,
  lastCandle: Candle | undefined,
  now = new Date(),
): Candle | null {
  if (!instrument || !lastCandle) return null;
  const dated = Number(instrument.Date ?? instrument.dEven ?? instrument.DEven ?? 0);
  if (Number.isInteger(dated) && dated >= 19000101 && dated <= 29991231) return null; // has a date: not our case
  const high = Number(instrument.PriceMax);
  const low = Number(instrument.PriceMin);
  const close = Number(instrument.PriceClose);
  const yesterday = Number(instrument.PriceYesterday);
  const volume = Number(instrument.Volume);
  if (![high, low, close, yesterday].every((value) => Number.isFinite(value) && value > 0)) return null;
  if (!Number.isFinite(volume) || volume <= 0) return null;
  if (yesterday !== lastCandle.close) return null; // chain broken: cannot anchor the snapshot to our history
  const sameSession = high === lastCandle.close && low === lastCandle.close && close === lastCandle.close;
  if (sameSession) return null; // restatement of the last candle, not a new session
  const expected = nextTradingDayCompact(lastCandle.d_even);
  if (!expected) return null;
  // Never during live hours: the inferred candle must already be closed.
  if (!isClosedTehranDailyCandle(expected, now)) return null;
  const optionalNumber = (value: unknown) => value !== null && value !== undefined && Number.isFinite(Number(value)) ? Number(value) : undefined;
  return { d_even: expected, high, low, close, last: optionalNumber(instrument.PriceLast), open: optionalNumber(instrument.PriceFirst), yesterday };
}

export function latestMarketDate(histories: Iterable<Candle[]>) {
  let latest: number | null = null;
  for (const candles of histories) {
    for (const candle of candles) {
      const date = Number(candle.d_even || 0);
      if (date && (latest === null || date > latest)) latest = date;
    }
  }
  return latest;
}

export type ShareChange = {
  date: number;
  oldShares: number;
  newShares: number;
};

export type PeriodMetrics = {
  startPrice: number;
  peakPrice: number;
  currentPrice: number;
  returnPct: number;
  drawdownPct: number;
  startDate: string;
  peakDate: string;
  currentDate: string;
};

export type CorporateAction = {
  kind: "افزایش سرمایه" | "شکاف تعدیل نیازمند بررسی";
  date: string;
  before: number | null;
  after: number | null;
  percent: number;
  confirmed: boolean;
  oldShares?: number;
  newShares?: number;
};

export type MarketHighlight = {
  sessionDate?: number | null;
  quoteSource?: string;
  quoteFetchedAt?: string;
  delivery?: string;
  insCode: string;
  symbol: string;
  name: string;
  volume: number;
  value: number;
  netRealValue: number | null;
  priceYesterday: number;
  priceFirst: number;
  priceMin: number;
  priceLast: number;
  priceClose: number;
  allowedMin: number;
  firstChangePct: number;
  minChangePct: number;
  lastChangePct: number;
  closeChangePct: number;
  lastCloseGapPct: number;
  reversalPct: number;
  touchedSellQueue: boolean;
  floorVerified: boolean;
  realBuyVolume: number;
  realSellVolume: number;
  legalBuyVolume: number;
  legalSellVolume: number;
  realBuyCount: number;
  realSellCount: number;
  legalBuyCount: number;
  legalSellCount: number;
  buyPower: number;
  clientTypeAvailable: boolean;
  volumeAvailable?: boolean;
  valueAvailable?: boolean;
  realBuyValue?: number | null;
  realSellValue?: number | null;
  clientTypeDate?: number | null;
  clientTypeFetchedAt?: string;
  floorDate?: number | null;
  floorFetchedAt?: string;
};

export type ValuationMetrics = {
  eps: number;
  pe: number;
  sectorPe: number;
  epsSectorPePrice: number | null;
  epsSectorPeUpsidePct: number | null;
  epsSectorPePositive: boolean;
  peBelowSector: boolean;
};

export type MajorIndividualHoldingIncrease = {
  id: string;
  insCode: string;
  instrumentName: string;
  shareholderType: "شخص حقیقی";
  previousShares: number | null;
  currentShares: number;
  changeShares: number;
  changeEvidence: "snapshot" | "official";
  date: number;
};

export type MajorIndividualHoldingChange = MajorIndividualHoldingIncrease;

export type MajorIndividualHoldingSummary = {
  buyCount: number;
  sellCount: number;
  buyShares: number;
  sellShares: number;
};

export type ScreenerRow = {
  symbol: string;
  name?: string;
  insCode?: string;
  rsi: number | null;
  realHolders: number | null;
  holderChange?: MajorIndividualHoldingSummary;
  three: PeriodMetrics | null;
  six: PeriodMetrics | null;
  /** Dated closing quote survives a blocked/insufficient 90/180-day return. */
  priceQuote?: { closeRial: number; sessionDate: number } | null;
  peakDrops?: Record<"1m" | "2m" | "3m", PeriodMetrics | null>;
  actions: CorporateAction[];
  status: "ready" | "warning" | "error";
  note?: string;
  divergence?: DayOverDayDivergence | null;
  divergenceAnalysis?: DivergenceAnalysis;
  analysisInput?: { candles: Candle[]; changes: ShareChange[]; eps: number; pe: number; sectorPe: number };
  quoteVerified?: boolean;
  valuation?: ValuationMetrics | null;
};

export const normalizeSymbol = (value: string) =>
  value
    .replace(/ك/g, "ک")
    .replace(/ي/g, "ی")
    .replace(/[\u200c\u200f\ufeff]/g, "")
    .replace(/\s+/g, " ")
    .trim();

export const toApiSymbol = (value: string) =>
  normalizeSymbol(value).replace(/ک/g, "ك").replace(/ی/g, "ي");

export type WatchlistSource = "haghighi" | "zarbanana" | "custom";
export type WatchlistScope = WatchlistSource | "all";
export function symbolsForScope(lists: Record<WatchlistSource, string[]>, scope: WatchlistScope) {
  const values = scope === "all" ? [...lists.haghighi, ...lists.zarbanana, ...lists.custom] : lists[scope];
  return [...new Set(values.map(normalizeSymbol).filter(Boolean))];
}

export const normalizeHolderIdentity = (value: string) =>
  normalizeSymbol(value).replace(/[\s\u200c\u200f\ufeff]+/g, "");

export function compactTehranDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return Number(`${values.year}${values.month}${values.day}`);
}

export function latestNonFutureDate(values: unknown[], now = new Date()) {
  // Legacy public name; for shareholder slots "nonfuture" also means the
  // ordinary-equity session has actually CLOSED in Tehran.
  return selectHolderSession(values, now).sourceDate;
}

export function mergeCandlesByDate(primary: Candle[], secondary: Candle[]): Candle[] {
  const byDate = new Map<number, Candle>();
  for (const candle of secondary) {
    if (Number.isInteger(candle.d_even)) byDate.set(candle.d_even, candle);
  }
  for (const candle of primary) {
    if (Number.isInteger(candle.d_even)) byDate.set(candle.d_even, candle);
  }
  return [...byDate.values()].sort((a, b) => b.d_even - a.d_even);
}

function officialHolderChange(instrument: Record<string, unknown>) {
  const directFields = [
    "officialChangeShares",
    "changeShares",
    "shareCountChange",
    "numberOfShareChange",
    "changeAmount",
    "amount",
  ];
  for (const field of directFields) {
    const value = Number(instrument[field]);
    if (Number.isFinite(value) && value !== 0) return value;
  }
  const change = instrument.change;
  if (change && typeof change === "object") {
    const nested = change as Record<string, unknown>;
    for (const field of ["shares", "shareCount", "amount"]) {
      const value = Number(nested[field]);
      if (Number.isFinite(value) && value !== 0) return value;
    }
  }
  return null;
}

/**
 * Extract confirmed signed changes from TSETMC's whole-market, five-session
 * shareholder-change dataset. A missing/zero prior snapshot is accepted only
 * when the upstream record itself supplies a reliable non-zero share change.
 */
export function extractMajorIndividualHoldingChanges(payload: unknown, options: { now?: Date } = {}): MajorIndividualHoldingChange[] {
  const root = payload as Record<string, unknown> | null;
  const dates = Array.isArray(root?.dates) ? root.dates.map(Number) : [];
  const holders = Array.isArray(root?.shareHoldersChanges) ? root.shareHoldersChanges : [];
  const dayKeys = ["firstDay", "secondDay", "thirdDay", "fourthDay", "fifthDay"] as const;
  const selection = selectHolderSession(dates.slice(0, dayKeys.length), options.now);
  const lastIndex = selection.index, previousIndex = selection.previousIndex;
  if (lastIndex < 1 || previousIndex < 0) return [];

  const result: MajorIndividualHoldingChange[] = [];
  const seen = new Set<string>();
  for (const [holderIndex, rawHolder] of holders.entries()) {
    const holder = rawHolder as Record<string, unknown>;
    if (normalizeHolderIdentity(String(holder.name ?? "")) !== "شخصحقیقی") continue;
    const instruments = Array.isArray(holder.insList) ? holder.insList : [];
    for (const rawInstrument of instruments) {
      const instrument = rawInstrument as Record<string, unknown>;
      const insCode = String(instrument.insCode ?? "").trim();
      const previousValue = instrument[dayKeys[previousIndex]];
      const parsedPrevious = Number(previousValue);
      const previousShares = previousValue === undefined || previousValue === null || previousValue === "" || !Number.isFinite(parsedPrevious)
        ? null
        : parsedPrevious;
      const currentValue = instrument[dayKeys[lastIndex]];
      if (currentValue === undefined || currentValue === null || currentValue === "") continue;
      const currentShares = Number(currentValue);
      if (!insCode || !Number.isFinite(currentShares) || currentShares < 0) continue;
      let changeShares: number;
      let changeEvidence: MajorIndividualHoldingChange["changeEvidence"];
      if (previousShares !== null && previousShares > 0) {
        if (currentShares === previousShares) continue;
        changeShares = currentShares - previousShares;
        changeEvidence = "snapshot";
      } else {
        const officialChange = officialHolderChange(instrument);
        if (officialChange === null) continue;
        changeShares = officialChange;
        changeEvidence = "official";
      }
      const date = dates[lastIndex];
      const sourceHolderId = String(holder.id ?? holder.shareHolderId ?? holder.code ?? "").trim();
      // Anonymous records with equal holdings can be different people. Only
      // a source identity is sufficient evidence for cross-record deduplication.
      const id = `${insCode}:${sourceHolderId || `anonymous-${holderIndex}`}:${date}:${previousShares ?? "unknown"}:${currentShares}:${changeShares}`;
      if (seen.has(id)) continue;
      seen.add(id);
      result.push({
        id,
        insCode,
        instrumentName: normalizeSymbol(String(instrument.name ?? "")),
        shareholderType: "شخص حقیقی",
        previousShares,
        currentShares,
        changeShares,
        changeEvidence,
        date,
      });
    }
  }
  return result.sort((a, b) => Math.abs(b.changeShares) - Math.abs(a.changeShares) || a.instrumentName.localeCompare(b.instrumentName, "fa"));
}

export function extractMajorIndividualHoldingIncreases(payload: unknown): MajorIndividualHoldingIncrease[] {
  return extractMajorIndividualHoldingChanges(payload)
    .filter((item) => item.changeShares > 0)
    .sort((a, b) => b.changeShares - a.changeShares || a.instrumentName.localeCompare(b.instrumentName, "fa"));
}

export function summarizeMajorIndividualHoldingChanges(changes: MajorIndividualHoldingChange[]) {
  const summaries: Record<string, MajorIndividualHoldingSummary> = {};
  for (const change of changes) {
    const current = summaries[change.insCode] ?? { buyCount: 0, sellCount: 0, buyShares: 0, sellShares: 0 };
    if (change.changeShares > 0) {
      current.buyCount += 1;
      current.buyShares += change.changeShares;
    } else if (change.changeShares < 0) {
      current.sellCount += 1;
      current.sellShares += Math.abs(change.changeShares);
    }
    summaries[change.insCode] = current;
  }
  return summaries;
}

/** Compare last trade with the SAME session's closing price, never with
 * yesterday's close. Keep the rial gap separate from the percent gap. */
export function closingPriceGap(priceLast: number, priceClose: number): { rial: number; percent: number } | null {
  if (![priceLast, priceClose].every((value) => Number.isFinite(value) && value > 0)) return null;
  return {
    rial: round(priceLast - priceClose, 2),
    percent: round(((priceLast - priceClose) / priceClose) * 100, 2),
  };
}

export function marketHighlightFromInstrument(
  raw: Record<string, unknown>,
  clientType?: Record<string, unknown> | null,
): MarketHighlight | null {
  const number = (...keys: string[]) => {
    for (const key of keys) {
      const parsed = Number(raw[key]);
      if (Number.isFinite(parsed)) return parsed;
    }
    return 0;
  };
  const symbol = normalizeSymbol(String(raw.Symbol ?? raw.symbol ?? ""));
  const insCode = String(raw.InsCode ?? raw.insCode ?? raw.ins_code ?? "").trim();
  const priceYesterday = number("PriceYesterday", "priceYesterday");
  const priceFirst = number("PriceFirst", "priceFirst") || priceYesterday;
  const priceMin = number("PriceMin", "priceMin") || priceFirst;
  const priceLast = number("PriceLast", "priceLast") || number("PriceClose", "priceClose");
  const priceClose = number("PriceClose", "priceClose") || priceLast;
  if (!symbol || priceYesterday <= 0 || priceLast <= 0) return null;
  const pctFromYesterday = (price: number) => round(((price - priceYesterday) / priceYesterday) * 100, 2);
  const allowedMin = number("AllowedMin", "allowedMin");
  const clientNumber = (...keys: string[]) => {
    for (const key of keys) {
      const parsed = Number(clientType?.[key]);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return 0;
  };
  const realBuyVolume = clientNumber("buy_I_Volume", "buyIVolume");
  const realSellVolume = clientNumber("sell_I_Volume", "sellIVolume");
  const legalBuyVolume = clientNumber("buy_N_Volume", "buyNVolume");
  const legalSellVolume = clientNumber("sell_N_Volume", "sellNVolume");
  const realBuyCount = clientNumber("buy_CountI", "buyCountI");
  const realSellCount = clientNumber("sell_CountI", "sellCountI");
  const legalBuyCount = clientNumber("buy_CountN", "buyCountN");
  const legalSellCount = clientNumber("sell_CountN", "sellCountN");
  const calculatedBuyPower = realBuyCount > 0 && realSellCount > 0 && realSellVolume > 0
    ? (realBuyVolume / realBuyCount) / (realSellVolume / realSellCount)
    : 0;
  const upstreamBuyPower = number("BuyPower", "buyPower");
  return {
    insCode,
    symbol,
    sessionDate: instrumentSession(raw),
    quoteSource: typeof raw.quoteSource === "string" ? raw.quoteSource : undefined,
    quoteFetchedAt: typeof raw.quoteFetchedAt === "string" ? raw.quoteFetchedAt : undefined,
    delivery: typeof raw.delivery === "string" ? raw.delivery : undefined,
    name: String(raw.Name ?? raw.name ?? ""),
    volume: Math.max(0, number("Volume", "volume")),
    value: Math.max(0, number("Value", "value")),
    volumeAvailable: [raw.Volume, raw.volume].some(value => value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0),
    valueAvailable: [raw.Value, raw.value].some(value => value != null && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0),
    netRealValue: raw.NetRealValue == null && raw.netRealValue == null ? null : number("NetRealValue", "netRealValue"),
    priceYesterday,
    priceFirst,
    priceMin,
    priceLast,
    priceClose,
    allowedMin,
    firstChangePct: pctFromYesterday(priceFirst),
    minChangePct: pctFromYesterday(priceMin),
    lastChangePct: pctFromYesterday(priceLast),
    closeChangePct: pctFromYesterday(priceClose),
    // Unlike the two day-on-day change labels, this compares prices with the
    // SAME session's close. Denominator is today's close, not yesterday's.
    lastCloseGapPct: closingPriceGap(priceLast, priceClose)?.percent ?? 0,
    reversalPct: priceMin > 0 ? round(((priceLast - priceMin) / priceMin) * 100, 2) : 0,
    touchedSellQueue: allowedMin > 0 && priceMin > 0 && Math.abs(priceMin - allowedMin) < 0.5,
    floorVerified: allowedMin > 0 && Boolean(instrumentSession(raw)) && number("AllowedMinDate") === instrumentSession(raw),
    realBuyVolume,
    realSellVolume,
    legalBuyVolume,
    legalSellVolume,
    realBuyCount,
    realSellCount,
    legalBuyCount,
    legalSellCount,
    buyPower: upstreamBuyPower > 0 ? round(upstreamBuyPower, 3) : round(calculatedBuyPower, 3),
    clientTypeAvailable: Boolean(clientType) && [realBuyVolume, realSellVolume, legalBuyVolume, legalSellVolume].some((value) => value > 0),
  };
}

/** Add official TSETMC buyer/seller breakdown to an already-built row. */
export function applyClientTypeToHighlight(
  row: MarketHighlight,
  clientType?: Record<string, unknown> | null,
): MarketHighlight {
  const number = (...keys: string[]) => {
    for (const key of keys) {
      const parsed = Number(clientType?.[key]);
      if (Number.isFinite(parsed)) return Math.max(0, parsed);
    }
    return 0;
  };
  const realBuyVolume = number("buy_I_Volume", "buyIVolume");
  const realSellVolume = number("sell_I_Volume", "sellIVolume");
  const legalBuyVolume = number("buy_N_Volume", "buyNVolume");
  const legalSellVolume = number("sell_N_Volume", "sellNVolume");
  const realBuyCount = number("buy_CountI", "buyCountI");
  const realSellCount = number("sell_CountI", "sellCountI");
  const legalBuyCount = number("buy_CountN", "buyCountN");
  const legalSellCount = number("sell_CountN", "sellCountN");
  const calculatedBuyPower = realBuyCount > 0 && realSellCount > 0 && realSellVolume > 0
    ? (realBuyVolume / realBuyCount) / (realSellVolume / realSellCount)
    : 0;
  const available = Boolean(clientType) && [realBuyVolume, realSellVolume, legalBuyVolume, legalSellVolume]
    .some((value) => value > 0);
  return {
    ...row,
    realBuyVolume,
    realSellVolume,
    legalBuyVolume,
    legalSellVolume,
    realBuyCount,
    realSellCount,
    legalBuyCount,
    legalSellCount,
    buyPower: row.buyPower > 0 ? row.buyPower : round(calculatedBuyPower, 3),
    clientTypeAvailable: available,
  };
}

export function isSellQueueToPositive(row: MarketHighlight) {
  return row.floorVerified && row.touchedSellQueue && row.lastChangePct > 0 && row.closeChangePct < 0;
}

const NON_SYMBOL_LABELS = new Set([
  "نماد", "نام نماد", "قیمت", "قیمت پایانی", "قیمت پایانی امروز", "آخرین قیمت",
  "درصد", "درصد پایانی", "تغییر", "حجم", "ارزش", "تعداد", "ردیف", "رتبه",
  "حقیقی", "حقیقی عمده", "تعداد حقیقی", "تعداد حقیقی عمده", "بازده", "ریزش", "رشد",
]);

function symbolFromCopiedLine(rawLine: string) {
  // Keep columns intact until selecting text; Persian digits are not letters.
  const cells = rawLine.split(/\t+|\s{2,}/).map((item) => item.trim()).filter(Boolean);
  const textCell = cells.find((item) => /[\u0621-\u063a\u0641-\u064a\u066e-\u06d3]/.test(item));
  if (textCell && NON_SYMBOL_LABELS.has(normalizeSymbol(textCell))) return "";
  let line = normalizeSymbol(textCell ?? rawLine)
    .replace(/^[\s•●▪◦*]+/, "")
    .replace(/^[۰-۹0-9]+[.)،:\-]?\s+/, "")
    .replace(/^نماد\s*[:：\-]?\s+/, "")
    .trim();
  if (!line || !/[\u0600-\u06ff]/.test(line)) return "";

  // A copied watchlist normally separates columns with tabs or several spaces.
  // Pick the first Persian text cell, even when a numeric rank precedes it.
  line = line
    .replace(/^[۰-۹0-9]+[.)،:\-]?\s+/, "")
    .replace(/^نماد\s*[:：\-]?\s+/, "")
    .trim();

  const words: string[] = [];
  for (const token of line.split(/\s+/)) {
    if (/[۰-۹0-9٪%]/.test(token)) break;
    const word = token.replace(/[^\u0600-\u06ff]/g, "");
    if (!word) {
      if (words.length) break;
      continue;
    }
    words.push(word);
  }

  const candidate = normalizeSymbol(words.join(" "));
  if (!candidate || NON_SYMBOL_LABELS.has(candidate) || candidate.split(" ").length > 4) return "";
  return candidate;
}

export const parseSymbolList = (text: string) => Array.from(new Set(
  text
    .split(/[\n,،;|]+/)
    .map(symbolFromCopiedLine)
    .filter(Boolean),
));

const compactDate = (date: Date) =>
  date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();

const dateFromCompact = (value: number) => {
  const text = String(value);
  return new Date(Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8))));
};

export const subtractCalendarDays = (compact: number, days: number) => {
  const source = dateFromCompact(compact);
  const target = new Date(source.getTime() - days * 86_400_000);
  return compactDate(target);
};

const round = (value: number, digits = 2) => {
  const scale = 10 ** digits;
  return Math.round((value + Number.EPSILON) * scale) / scale;
};


/**
 * Customer formula #1: EPS × sector P/E, rounded to the nearest 10 Rial to
 * match the annotated example (3,879 × 17.44 → 67,650).
 * Customer formula #2: the symbol's own positive P/E must be below sector P/E.
 */
export function calculateValuationMetrics(
  priceClose: number,
  eps: number,
  pe: number,
  sectorPe: number,
): ValuationMetrics {
  const safePriceClose = Number.isFinite(priceClose) ? priceClose : 0;
  const safeEps = Number.isFinite(eps) ? eps : 0;
  const safePe = Number.isFinite(pe) ? pe : 0;
  const safeSectorPe = Number.isFinite(sectorPe) ? sectorPe : 0;
  const inputsArePositive = safeEps > 0 && safeSectorPe > 0;
  const rawReferencePrice = safeEps * safeSectorPe;
  const epsSectorPePrice = inputsArePositive && Number.isFinite(rawReferencePrice)
    ? Math.round(rawReferencePrice / 10) * 10
    : null;
  const epsSectorPeUpsidePct = epsSectorPePrice !== null && safePriceClose > 0
    ? round(((epsSectorPePrice - safePriceClose) / safePriceClose) * 100, 2)
    : null;
  return {
    eps: safeEps,
    pe: safePe,
    sectorPe: safeSectorPe,
    epsSectorPePrice,
    epsSectorPeUpsidePct,
    epsSectorPePositive: epsSectorPeUpsidePct !== null && epsSectorPeUpsidePct > 0,
    peBelowSector: safePe > 0 && safeSectorPe > 0 && safePe < safeSectorPe,
  };
}

export function calculateRsi(candlesDescending: Candle[], period = 14, changes: ShareChange[] = []) {
  if (!Number.isInteger(period) || period < 1) return null;
  const closes = adjustedCandles(candlesDescending, changes)
    .sort((a, b) => a.d_even - b.d_even)
    .map((item) => item.close);

  // Dropping a malformed close would connect two non-adjacent sessions and
  // silently change Wilder's seed and every subsequent RSI observation.
  if (closes.length <= period || closes.some((close) => !Number.isFinite(close) || close <= 0)) return null;

  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let averageGain = gain / period;
  let averageLoss = loss / period;

  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
  }

  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  return round(100 - 100 / (1 + averageGain / averageLoss), 2);
}

function adjustedCandles(candles: Candle[], changes: ShareChange[]) {
  return candles.map((candle) => {
    let factor = 1;
    for (const change of changes) {
      if (candle.d_even < change.date && change.newShares > 0 && change.oldShares > 0) {
        factor *= change.oldShares / change.newShares;
      }
    }
    return {
      ...candle,
      close: candle.close * factor,
      high: candle.high * factor,
      low: candle.low === undefined ? undefined : candle.low * factor,
      open: candle.open === undefined ? undefined : candle.open * factor,
      yesterday: candle.yesterday === undefined ? undefined : candle.yesterday * factor,
    };
  });
}

export function calculatePeriod(candlesDescending: Candle[], days: 30 | 60 | 90 | 180, changes: ShareChange[] = []): PeriodMetrics | null {
  // A single verified session still supplies the current price when historical
  // coverage is partial; the API's price outcomes rely on this fallback.
  if (!candlesDescending.length) return null;
  const candles = adjustedCandles(candlesDescending, changes).sort((a, b) => a.d_even - b.d_even);
  const latest = candles[candles.length - 1];
  if (!validGregorianDate(latest.d_even)) return null;
  const cutoff = subtractCalendarDays(latest.d_even, days);
  const periodCandles = candles.filter((item) => item.d_even >= cutoff);
  if (!periodCandles.length || periodCandles.some((item) =>
    !validGregorianDate(item.d_even) || !Number.isFinite(item.close) || item.close <= 0 ||
    !Number.isFinite(item.high) || item.high < item.close ||
    (item.low !== undefined && (!Number.isFinite(item.low) || item.low <= 0 || item.low > item.close))
  )) return null;
  const start = periodCandles[0];
  const peak = periodCandles.reduce((best, item) => item.high > best.high ? item : best, periodCandles[0]);
  return {
    startPrice: round(start.close, 2),
    peakPrice: round(peak.high, 2),
    currentPrice: round(latest.close, 2),
    returnPct: round((latest.close / start.close - 1) * 100, 2),
    drawdownPct: round(Math.max(0, (1 - latest.close / peak.high) * 100), 2),
    startDate: String(start.d_even),
    peakDate: String(peak.d_even),
    currentDate: String(latest.d_even),
  };
}

export function detectGapActions(candlesDescending: Candle[], changes: ShareChange[], earliestDate: number) {
  const candles = [...candlesDescending].sort((a, b) => a.d_even - b.d_even);
  const actions: CorporateAction[] = [];

  for (const change of changes.filter((item) => item.date >= earliestDate)) {
    const beforeCandle = [...candles].reverse().find((item) => item.d_even < change.date);
    const afterCandle = candles.find((item) => item.d_even >= change.date);
    actions.push({
      kind: "افزایش سرمایه",
      date: String(change.date),
      before: beforeCandle ? round(beforeCandle.close, 2) : null,
      after: afterCandle ? round(afterCandle.yesterday ?? afterCandle.close, 2) : null,
      percent: round((change.newShares / change.oldShares - 1) * 100, 2),
      confirmed: true,
      oldShares: change.oldShares,
      newShares: change.newShares,
    });
  }

  for (let index = 1; index < candles.length; index += 1) {
    const previous = candles[index - 1];
    const current = candles[index];
    if (current.d_even < earliestDate || !Number.isFinite(previous.close) || previous.close <= 0) continue;
    const hasReference = Number.isFinite(current.yesterday) && current.yesterday! > 0;
    const observedPrice = hasReference ? current.yesterday! : current.close;
    if (!Number.isFinite(observedPrice) || observedPrice <= 0) continue;
    const gap = Math.abs(observedPrice / previous.close - 1);
    // A missing reference cannot verify a corporate action. Only report an
    // unreferenced close break if it exceeds ordinary consecutive limit moves.
    if (gap < (hasReference ? 0.08 : 0.16)) continue;
    if (!hasReference && index >= 2 && Number.isFinite(candles[index - 2].close) && candles[index - 2].close > 0 &&
        Math.abs(current.close / candles[index - 2].close - 1) <= 0.16) continue;
    const currentDate = dateFromCompact(current.d_even).getTime();
    const official = changes.find((item) => Math.abs(dateFromCompact(item.date).getTime() - currentDate) <= 7 * 86_400_000);
    if (official) continue;
    actions.push({
      kind: "شکاف تعدیل نیازمند بررسی",
      date: String(current.d_even),
      before: round(previous.close, 2),
      after: round(observedPrice, 2),
      percent: round(gap * 100, 2),
      confirmed: false,
    });
  }
  return actions.sort((a, b) => Number(b.date) - Number(a.date));
}

export function sixMonthCutoff(latest: number) {
  return subtractCalendarDays(latest, 180);
}

// ─── Divergence Detection ──────────────────────────────────────────────────

/**
 * A Tehran daily candle is final after the application's market-session
 * boundary. Keeping this check in the calculation layer prevents an intraday
 * snapshot from ever being reported as a confirmed divergence.
 */
function tehranMarketClock(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    today: Number(`${values.year}${values.month}${values.day}`),
    hour: Number(values.hour),
  };
}

function isClosedTehranDailyCandleAt(compact: number, marketClock: { today: number; hour: number }) {
  if (!Number.isInteger(compact) || compact < 19000101 || compact > 29991231) return false;
  if (compact < marketClock.today) return true;
  if (compact > marketClock.today) return false;
  return marketClock.hour >= 13;
}

export function isClosedTehranDailyCandle(compact: number, now = new Date()) {
  return isClosedTehranDailyCandleAt(compact, tehranMarketClock(now));
}

/** Regular day-over-day divergence only (client spec 2026-09-12). */
export function detectDivergence(candles: Candle[], changes: ShareChange[] = [], lookbackDays = 90, options: DivergenceOptions = {}) {
  return analyzeDivergence(candles, changes, lookbackDays, options).divergence;
}
