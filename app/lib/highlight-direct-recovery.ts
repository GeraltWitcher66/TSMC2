import { marketHighlightFromInstrument, normalizeSymbol, toApiSymbol, type MarketHighlight } from "./market";
import { instrumentFromDailyRows, instrumentSession, validHighlightSnapshotSession } from "./market-session";
import { fetchWithTimeout, readApiJson } from "./request-lifecycle";
import { expectedHighlightSession } from "./highlight-session";

const SOURCE = "https://zarvanfund.ir/api";

/** Independent CORS recovery for the *highlights* price stage only.
 * Neither an undated instruments snapshot nor a successful empty HTTP body
 * can establish a session. Never synthesize real-money or allowed-floor data. */
export async function recoverHighlightPrices(
  names: string[], signal: AbortSignal, request: typeof fetch = fetch,
): Promise<{ rows: MarketHighlight[]; partial: boolean; latestDate: number | null; missingCount: number; fetchedAt: string }> {
  const symbols = [...new Set(names.map(normalizeSymbol).filter(Boolean))];
  if (!symbols.length || symbols.length > 10) throw new Error("دسته بازیابی قیمت نامعتبر است.");
  const syms = encodeURIComponent(symbols.map(toApiSymbol).join(","));
  const read = async (url: string, ms: number) => {
    const res = await fetchWithTimeout(url, { signal, cache: "no-store", headers: { Accept: "application/json" } }, ms, request);
    if (!res.ok) throw new Error(`منبع تاریخ‌دار HTTP ${res.status} برگرداند.`);
    const value = await readApiJson<Record<string, unknown>>(res);
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("ساختار پاسخ منبع تاریخ‌دار معتبر نیست.");
    return new Map(Object.entries(value).map(([key, raw]) => [normalizeSymbol(key), raw]));
  };

  // Independent requests: a 503 from the undated snapshot must not hide a
  // complete dated daily batch; missing metadata just means unknown insCode.
  const [instrumentResult, dailyResult] = await Promise.allSettled([
    read(`${SOURCE}/instruments?syms=${syms}`, 11_000),
    read(`${SOURCE}/daily-batch?limit=3&syms=${syms}`, 14_000),
  ]);
  if (instrumentResult.status === "rejected" && dailyResult.status === "rejected") throw new Error("داده قیمت از سرور و منبع مستقل در دسترس نبود.");
  const instruments = instrumentResult.status === "fulfilled" ? instrumentResult.value : new Map<string, unknown>();
  const daily = dailyResult.status === "fulfilled" ? dailyResult.value : new Map<string, unknown>();
  const rows = symbols.flatMap((symbol): MarketHighlight[] => {
    const initial = instruments.get(symbol);
    const raw = initial && typeof initial === "object" && !Array.isArray(initial) ? initial as Record<string, unknown> : {};
    const maxSession = expectedHighlightSession(String(raw.Name ?? raw.name ?? symbol));
    const datedDaily = instrumentFromDailyRows(daily.get(symbol), maxSession);
    const snapshotDate = validHighlightSnapshotSession(raw, maxSession);
    const useDaily = Boolean(datedDaily && (!snapshotDate || Number(datedDaily.Date) >= snapshotDate));
    const quote = useDaily
      ? { ...raw, AllowedMin: null, AllowedMinDate: null, NetRealValue: null, BuyPower: 0, ...datedDaily }
      : snapshotDate ? raw : { ...raw, Date: null, date: null, DEven: null, dEven: null };
    if (!instrumentSession(quote)) return [];
    const parsed = marketHighlightFromInstrument({
      ...quote, Symbol: symbol, quoteSource: useDaily ? "zarvan-daily" : "zarvan-instruments",
      quoteFetchedAt: new Date().toISOString(), delivery: "source",
    });
    return parsed ? [{ ...parsed, clientTypeAvailable: false, netRealValue: null,
      realBuyValue: null, realSellValue: null, clientTypeDate: null,
      floorVerified: false, allowedMin: 0, touchedSellQueue: false }] : [];
  });
  if (!rows.length) throw new Error("داده قیمت تاریخ‌دار معتبر برای این دسته دریافت نشد.");
  return {
    rows, partial: rows.length !== symbols.length, missingCount: symbols.length - rows.length,
    latestDate: Math.max(...rows.map((row) => row.sessionDate ?? 0)) || null,
    fetchedAt: new Date().toISOString(),
  };
}
