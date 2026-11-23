import { candleFromInstrument } from "./market";
import { mapWithConcurrency, RequestCoalescer } from "./data-reliability";
import { upstreamJson, type UpstreamDiagnostic } from "./upstream";
import { sourceSession } from "./market-session";

export const QUOTE_BATCH_SIZE = 20;
const cache = new RequestCoalescer<Record<string, unknown>>(10_000, 400);
const OFFICIAL_HOSTS = ["cdn.tsetmc.com", "tsetmc.com"] as const;
const HOST_FAILURE_THRESHOLD = 2;
const HOST_COOLDOWN_MS = 15_000;
// A page request must stay a simple CORS request: a User-Agent, Referer or
// Cache-Control header triggers a preflight that the official hosts refuse.
const runningInBrowser = typeof window !== "undefined";
const OFFICIAL_HEADERS: Record<string, string> = runningInBrowser
  ? { Accept: "application/json" }
  : { Accept: "application/json", "User-Agent": "Mozilla/5.0", Referer: "https://tsetmc.com/", "Cache-Control": "no-cache" };
const OFFICIAL_QUOTE_TIMEOUT_MS = runningInBrowser ? 8_000 : 3_500;
const hostFailures = new Map<string, { count: number; blockedUntil: number }>();

/** A short, per-host circuit breaker. Failure does not prove the quote is zero. */
function hostAvailable(host: string, now = Date.now()) {
  return (hostFailures.get(host)?.blockedUntil ?? 0) <= now;
}
function recordHost(host: string, success: boolean, now = Date.now()) {
  if (success) { hostFailures.delete(host); return; }
  const previous = hostFailures.get(host);
  const count = previous?.blockedUntil && previous.blockedUntil <= now ? 1 : (previous?.count ?? 0) + 1;
  hostFailures.set(host, { count, blockedUntil: count >= HOST_FAILURE_THRESHOLD ? now + HOST_COOLDOWN_MS : 0 });
}

/** Only the instrument's own dated, traded session may supply its current candle. */
export function instrumentFromClosingPrice(payload: unknown, expectedCode?: string): Record<string, unknown> | null {
  const item = (payload as { closingPriceInfo?: Record<string, unknown> } | null)?.closingPriceInfo;
  if (!item) return null;
  // This single-instrument endpoint uses insCode=0 in real responses; bind it to its request path.
  if (expectedCode && item.insCode != null && String(item.insCode) !== "0" && String(item.insCode) !== expectedCode) return null;
  const result = {
    Date: sourceSession(item.dEven), PriceMax: item.priceMax, PriceMin: item.priceMin,
    PriceClose: item.pClosing, PriceLast: item.pDrCotVal, PriceFirst: item.priceFirst,
    PriceYesterday: item.priceYesterday, Volume: item.qTotTran5J, Value: item.qTotCap,
  };
  return candleFromInstrument(result) ? result : null;
}

export async function datedCurrentQuotes(instruments: Map<string, Record<string, unknown>>, observe?: (event: UpstreamDiagnostic) => void) {
  if (instruments.size > QUOTE_BATCH_SIZE) throw new Error("Quote batch exceeds supported size");
  const results = await mapWithConcurrency([...instruments], 4, async ([symbol, instrument]) => {
    const code = String(instrument.InsCode ?? instrument.insCode ?? instrument.ins_code ?? "");
    if (!code) return [symbol, null] as const;
    try {
      let fetched = false;
      const quote = await cache.run(code, async () => {
        fetched = true;
        for (const host of OFFICIAL_HOSTS) {
          if (!hostAvailable(host)) continue;
          try {
            const payload = await upstreamJson(`https://${host}/api/ClosingPrice/GetClosingPriceInfo/${encodeURIComponent(code)}`, {
              headers: OFFICIAL_HEADERS, timeoutMs: OFFICIAL_QUOTE_TIMEOUT_MS, observe,
            });
            const parsed = instrumentFromClosingPrice(payload, code);
            // A syntactically valid but undated/untraded response is not proof
            // of host failure. The second official host may have a valid row.
            if (!parsed) continue;
            recordHost(host, true);
            return { ...parsed, quoteSource: "tsetmc-current", quoteHost: host, quoteFetchedAt: new Date().toISOString() };
          } catch {
            recordHost(host, false);
          }
        }
        throw new Error("No verified official dated quote");
      });
      const delivered: Record<string, unknown> = { ...quote, delivery: fetched ? "source" : "cache" };
      return [symbol, delivered] as const;
    } catch { return [symbol, null] as const; }
  });
  return new Map(results.flatMap(([symbol, quote]) => quote ? [[symbol, quote] as const] : []));
}
