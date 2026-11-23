import { candleFromInstrument, calculateValuationMetrics, mergeCandlesByDate, normalizeSymbol, toApiSymbol, type Candle, type ScreenerRow } from "./market";
import { isClosedScreenerSession, validSourceDailyPrice } from "./market-session";
import { recalculateScreenerRow } from "./screener-analysis";
import { fetchWithTimeout, readApiJson } from "./request-lifecycle";

const BASE = "https://zarvanfund.ir/api";

/** Used only if the Worker cannot serve a screener batch. Zarvan permits CORS
 * and supplies real, dated daily candles; all 90/180/RSI calculations still
 * pass through the same analysis engine as the Worker. */
export async function recoverDatedScreenerBatch(symbols: string[], signal: AbortSignal, request: typeof fetch = fetch) {
  if (!symbols.length || symbols.length > 20) throw new Error("اندازه دسته بازیابی نامعتبر است.");
  const requested = [...new Set(symbols.map(normalizeSymbol).filter(Boolean))];
  const encoded = encodeURIComponent(requested.map(toApiSymbol).join(","));
  const read = async (path: string, ms: number) => {
    const response = await fetchWithTimeout(`${BASE}/${path}`, { signal, cache: "no-store" }, ms, request);
    if (!response.ok) throw new Error(`منبع تاریخ‌دار HTTP ${response.status} برگرداند.`);
    const data = await readApiJson<Record<string, unknown>>(response);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("ساختار داده زروان معتبر نیست.");
    return data;
  };
  const [instrumentsResult, historyResult] = await Promise.allSettled([
    read(`instruments?syms=${encoded}`, 12_000),
    read(`daily-batch?limit=260&syms=${encoded}`, 25_000),
  ]);
  if (historyResult.status === "rejected") throw historyResult.reason;
  const instruments = instrumentsResult.status === "fulfilled" ? instrumentsResult.value : {};
  const normalizedInstruments = new Map(Object.entries(instruments).map(([symbol, raw]) => [normalizeSymbol(symbol), raw]));
  const histories = new Map(Object.entries(historyResult.value).map(([symbol, raw]) => [normalizeSymbol(symbol), raw]));
  const rows: ScreenerRow[] = requested.map((symbol) => {
    const raw = normalizedInstruments.get(symbol);
    const instrument = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    const daily = histories.get(symbol);
    const candles: Candle[] = Array.isArray(daily) ? daily.filter((row): row is Candle =>
      validSourceDailyPrice(row)) : [];
    const candidateQuote = candleFromInstrument(instrument);
    const datedQuote = candidateQuote && isClosedScreenerSession(candidateQuote.d_even) ? candidateQuote : null;
    const history = datedQuote ? mergeCandlesByDate([datedQuote], candles) : candles;
    const insCode = String(instrument?.InsCode ?? instrument?.insCode ?? instrument?.ins_code ?? "");
    if (!history.length) return { symbol, insCode, realHolders: null, rsi: null, three: null, six: null, actions: [], status: "error", note: "از منبع مستقیم، سابقه تاریخ‌دار قابل‌تأیید دریافت نشد." };
    const newest = Math.max(...history.map((item) => item.d_even));
    const latest = history.find((item) => item.d_even === newest)!;
    const valuation = calculateValuationMetrics(
      latest.close,
      Number(instrument?.Eps ?? instrument?.EPS ?? instrument?.EstimatedEPS ?? instrument?.estimatedEPS ?? 0),
      Number(instrument?.Pe ?? instrument?.PE ?? instrument?.pe ?? 0),
      Number(instrument?.SectorPE ?? instrument?.SectorPe ?? instrument?.sectorPE ?? instrument?.sectorPe ?? 0),
    );
    const row: ScreenerRow = {
      symbol, name: String(instrument?.Name ?? instrument?.name ?? ""), insCode,
      rsi: null, realHolders: null, three: null, six: null, actions: [],
      analysisInput: { candles: history, changes: [], eps: valuation.eps, pe: valuation.pe, sectorPe: valuation.sectorPe },
      valuation, status: "warning",
    };
    // A dated history is valid for financial calculations, but cannot prove
    // a fresh intraday official quote or an independently verified action.
    return recalculateScreenerRow(row, history, [], false);
  });
  // A dated closing price remains usable even when unresolved corporate
  // actions correctly suppress every 90/180-day performance metric.
  if (!rows.some((row) => row.priceQuote || row.three || row.six)) throw new Error("از مسیر بازیابی، هیچ سابقه قیمت قابل‌استفاده‌ای دریافت نشد.");
  const latestDate = Math.max(0, ...rows.map((row) => Number(row.priceQuote?.sessionDate ?? row.three?.currentDate ?? row.six?.currentDate ?? 0)));
  return { rows, latestDate: latestDate || null, fetchedAt: new Date().toISOString(), recovery: "direct-dated-zarvan" as const };
}
