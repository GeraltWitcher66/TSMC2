import { aggregateBuyPower, normalizeIndustryName, type IndustryRow } from "./industry";

/**
 * Per-symbol industry aggregation.
 *
 * Source of truth for the daily card is TSETMC itself: `GetMarketWatch` carries
 * each instrument's sector code (`csv`), closing/last price and traded value,
 * and `GetClientTypeAll` carries the real-money volumes, values and person
 * counts. The published `/api/sectors` numbers are only a fallback for when
 * this symbol-level data cannot be read.
 */
export const FUND_SECTOR_CODE = "68";

export type FundKind =
  | "صندوق اهرمی"
  | "صندوق زعفران"
  | "صندوق طلا و کالا"
  | "صندوق بخشی"
  | "صندوق درآمد ثابت"
  | "صندوق سهامی"
  | "صندوق مختلط و سایر";

export const FUND_KINDS: FundKind[] = [
  "صندوق اهرمی", "صندوق زعفران", "صندوق طلا و کالا", "صندوق بخشی",
  "صندوق درآمد ثابت", "صندوق سهامی", "صندوق مختلط و سایر",
];

/** A fund's row is decided by its name, in this exact order. */
export function fundKind(name: string, symbol = ""): FundKind {
  const text = normalizeIndustryName(`${name} ${symbol}`).toLowerCase();
  const endsWith = (suffix: string) => normalizeIndustryName(symbol).endsWith(suffix);
  if (text.includes("اهرمی")) return "صندوق اهرمی";
  if (text.includes("زعفران")) return "صندوق زعفران";
  if (/طلا|عیار|مثقال|کالا|کالای|زر/.test(text)) return "صندوق طلا و کالا";
  if (text.includes("بخشی")) return "صندوق بخشی";
  if (text.includes("درآمد ثابت") || text.includes("ثابت") || endsWith("-د")) return "صندوق درآمد ثابت";
  if (text.includes("سهامی") || text.includes("سهام") || endsWith("-س")) return "صندوق سهامی";
  return "صندوق مختلط و سایر";
}

export type MarketQuote = {
  insCode: string;
  symbol: string;
  name: string;
  sectorCode: string;
  close: number | null;
  last: number | null;
  prevClose: number | null;
  value: number | null;
  volume: number | null;
  /** Closing change in percent, computed from the previous close. */
  changePct: number | null;
};

export type SymbolFlow = {
  buyVolume: number | null;
  sellVolume: number | null;
  buyValue: number | null;
  sellValue: number | null;
  buyCount: number | null;
  sellCount: number | null;
};

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};
const str = (value: unknown) => String(value ?? "").trim();
const first = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null && row[key] !== "") return row[key];
  return undefined;
};

/** The market-watch payload leaves `pClosing`/`qTotCap` at zero and carries the
 * real figures in `pcl` and `qtc`; zero is never a usable price or value. */
const positive = (row: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const parsed = num(row[key]);
    if (parsed !== null && parsed > 0) return parsed;
  }
  return null;
};

/** `GetMarketWatch` rows, keyed by the instrument code used by ClientType. */
export function parseMarketWatch(payload: unknown): MarketQuote[] {
  const rows = (payload as { marketwatch?: unknown } | null)?.marketwatch;
  if (!Array.isArray(rows)) return [];
  // The watch feed can repeat an instrument across paper types; counting it
  // twice would double its value and its real-money flow.
  const seen = new Set<string>();
  return rows.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const insCode = str(first(row, ["insCode", "InsCode"]));
    const symbol = str(first(row, ["lva", "lVal18AFC", "symbol", "Symbol"]));
    if (!insCode || !symbol) return [];
    if (seen.has(insCode)) return [];
    seen.add(insCode);
    const last = positive(row, ["pdv", "pDrCotVal", "pl", "PriceLast"]);
    const close = positive(row, ["pcl", "pClosing", "PriceClose"]) ?? last;
    const prevClose = positive(row, ["py", "priceYesterday", "PriceYesterday"]);
    const changePct = close !== null && prevClose !== null && prevClose > 0 ? ((close - prevClose) / prevClose) * 100 : null;
    return [{
      insCode, symbol,
      name: str(first(row, ["lvc", "lVal30", "name", "Name"])) || symbol,
      sectorCode: str(first(row, ["csv", "cSecVal", "sectorCode"])),
      close, last, prevClose,
      value: positive(row, ["qtc", "qTotCap", "Value", "value"]),
      volume: positive(row, ["qtj", "qTotTran5J", "Volume", "volume"]),
      changePct,
    }];
  });
}

/** `GetClientTypeAll` rows: the only place with real-money volumes and counts. */
export function parseClientTypeAll(payload: unknown): Map<string, SymbolFlow> {
  const rows = (payload as { clientTypeAllDto?: unknown } | null)?.clientTypeAllDto;
  const map = new Map<string, SymbolFlow>();
  if (!Array.isArray(rows)) return map;
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const row = item as Record<string, unknown>;
    const insCode = str(first(row, ["insCode", "InsCode"]));
    if (!insCode) continue;
    map.set(insCode, {
      buyVolume: num(first(row, ["buy_I_Volume", "buyIVolume"])),
      sellVolume: num(first(row, ["sell_I_Volume", "sellIVolume"])),
      buyValue: num(first(row, ["buy_I_Value", "buyIValue"])),
      sellValue: num(first(row, ["sell_I_Value", "sellIValue"])),
      buyCount: num(first(row, ["buy_CountI", "buy_I_Count", "buyCountI"])),
      sellCount: num(first(row, ["sell_CountI", "sell_I_Count", "sellCountI"])),
    });
  }
  return map;
}

const RIGHTS_RE = /ح$/;
const OPTION_RE = /اختیار|اختيار|آپشن|option/i;
const BOND_RE = /اوراق|صکوک|صكوك|اجاره|مرابحه|سلف|منافع|اسناد خزانه|ورقه|حقتقدم|حق تقدم/;

/** Rights, bonds/options and defaulted instruments never belong in an industry total. */
export function excludedInstrument(quote: MarketQuote): string | null {
  if (RIGHTS_RE.test(quote.symbol) || BOND_RE.test(quote.name) || BOND_RE.test(quote.symbol)) return "rights-or-bond";
  if (OPTION_RE.test(quote.name) || OPTION_RE.test(quote.symbol)) return "option";
  return null;
}

/** First trading day or a session outside ±50% cannot be summed as a normal day. */
export function outlierInstrument(quote: MarketQuote): string | null {
  if (quote.prevClose === null || quote.prevClose <= 0) return "first-session";
  if (quote.changePct === null) return "unknown-change";
  if (Math.abs(quote.changePct) > 50) return "extreme-change";
  return null;
}

export type IndustrySymbolStats = {
  quotes: number;
  used: number;
  rightsOrBond: number;
  option: number;
  firstSession: number;
  extremeChange: number;
  noValue: number;
  noFlow: number;
  industries: number;
};

export type IndustrySymbolResult = { rows: IndustryRow[]; stats: IndustrySymbolStats };

/**
 * Aggregate per-symbol quotes + real-money flows into industry rows.
 *
 * - inflow = Σ (real buy volume − real sell volume) × closing price
 * - value  = Σ traded value
 * - buyers/sellers keep their sums so buy power stays a ratio of sums
 * - funds (sector 68) are split by fund type instead of one lumped row
 */
export function aggregateIndustrySymbols(
  quotes: MarketQuote[],
  flows: Map<string, SymbolFlow>,
  sectorNames: Record<string, string>,
): IndustrySymbolResult {
  const stats: IndustrySymbolStats = {
    quotes: quotes.length, used: 0, rightsOrBond: 0, option: 0,
    firstSession: 0, extremeChange: 0, noValue: 0, noFlow: 0, industries: 0,
  };
  type Totals = IndustryRow;
  const totals = new Map<string, Totals>();
  for (const quote of quotes) {
    const excluded = excludedInstrument(quote);
    if (excluded === "rights-or-bond") { stats.rightsOrBond += 1; continue; }
    if (excluded === "option") { stats.option += 1; continue; }
    const outlier = outlierInstrument(quote);
    if (outlier === "first-session") { stats.firstSession += 1; continue; }
    if (outlier === "extreme-change") { stats.extremeChange += 1; continue; }
    if (quote.value === null || quote.value <= 0) { stats.noValue += 1; continue; }

    let code = quote.sectorCode;
    let name = sectorNames[code];
    if (code === FUND_SECTOR_CODE) {
      const kind = fundKind(quote.name, quote.symbol);
      code = `${FUND_SECTOR_CODE}:${kind}`;
      name = kind;
    }
    if (!name) continue;

    const key = code;
    const current = totals.get(key) ?? {
      code, name, net: null, value: null, buyPower: null, symbols: 0,
      realBuyValue: null, realSellValue: null, buyCount: null, sellCount: null,
    };
    const flow = flows.get(quote.insCode);
    if (flow && flow.buyVolume !== null && flow.sellVolume !== null && quote.close !== null) {
      const net = (flow.buyVolume - flow.sellVolume) * quote.close;
      current.net = (current.net ?? 0) + net;
    }
    current.value = (current.value ?? 0) + quote.value;
    if (flow) {
      const add = (base: number | null, value: number | null) => value === null ? base : (base ?? 0) + value;
      // GetClientTypeAll publishes volumes and person counts only, so a missing
      // real value is the real volume at the symbol's average traded price
      // (value ÷ volume), never zero and never another industry's number.
      const averagePrice = quote.value !== null && quote.volume !== null && quote.volume > 0
        ? quote.value / quote.volume
        : quote.close;
      const realValue = (published: number | null, realVolume: number | null) =>
        published ?? (realVolume !== null && averagePrice ? realVolume * averagePrice : null);
      current.realBuyValue = add(current.realBuyValue, realValue(flow.buyValue, flow.buyVolume));
      current.realSellValue = add(current.realSellValue, realValue(flow.sellValue, flow.sellVolume));
      current.buyCount = add(current.buyCount, flow.buyCount);
      current.sellCount = add(current.sellCount, flow.sellCount);
    } else {
      stats.noFlow += 1;
    }
    current.symbols += 1;
    totals.set(key, current);
  }

  const rows = [...totals.values()]
    .map((row) => ({
      ...row,
      buyPower: aggregateBuyPower(row.realBuyValue, row.buyCount, row.realSellValue, row.sellCount),
    }))
    .sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
  stats.used = rows.reduce((sum, row) => sum + row.symbols, 0);
  stats.industries = rows.length;
  return { rows, stats };
}

/** A short status line for the card, so a degraded day is never mistaken for a full one. */
export function industryStatsText(stats: IndustrySymbolStats, symbols: number): string {
  const skipped = stats.firstSession + stats.extremeChange;
  const parts = [`${symbols} نماد بازار`];
  if (skipped) parts.push(`${skipped} نماد خارج از دامنه کنار گذاشته شد`);
  if (stats.noFlow) parts.push(`${stats.noFlow} نماد بدون داده حقیقی`);
  return parts.join(" · ");
}

/**
 * Symbols worth sweeping for earlier sessions: tradeable instruments with a
 * known industry. Rights, bonds, options and unknown sectors would only add
 * requests that can never enter a total.
 */
export function historySymbols(
  quotes: MarketQuote[], sectorNames: Record<string, string>, limit = 1200,
): { insCode: string; symbol: string; name: string; sectorCode: string }[] {
  const seen = new Set<string>();
  return quotes.flatMap((quote) => {
    if (!quote.insCode || seen.has(quote.insCode)) return [];
    if (excludedInstrument(quote)) return [];
    if (quote.sectorCode !== FUND_SECTOR_CODE && !sectorNames[quote.sectorCode]) return [];
    seen.add(quote.insCode);
    return [{ insCode: quote.insCode, symbol: quote.symbol, name: quote.name, sectorCode: quote.sectorCode }];
  }).slice(0, limit);
}

/**
 * When symbol-level money flow is unavailable the card falls back to the
 * published totals, but an industry whose only symbol is a listing-day or
 * ±50%-move outlier is still not a real industry that day, so it is dropped.
 */
export function dropIndustriesWithoutTradableSymbols(
  rows: IndustryRow[], quotes: MarketQuote[], sectorNames: Record<string, string>,
): IndustryRow[] {
  if (!quotes.length) return rows;
  const seen = new Map<string, number>();
  for (const quote of quotes) {
    const code = quote.sectorCode;
    if (!code || code === FUND_SECTOR_CODE) continue;
    const viable = !excludedInstrument(quote) && !outlierInstrument(quote) && quote.value !== null && quote.value > 0;
    seen.set(code, (seen.get(code) ?? 0) + (viable ? 1 : 0));
  }
  const drop = new Set([...seen.entries()].flatMap(([code, viable]) => viable === 0 ? [code] : []));
  if (!drop.size) return rows;
  const nameOf = (code: string) => sectorNames[code] ?? "";
  return rows.filter((row) => !drop.has(row.code) && !drop.has(Object.keys(sectorNames).find((code) => nameOf(code) === row.name) ?? ""));
}
