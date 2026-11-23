import { normalizeSymbol } from "../default-symbols";

export type MarketInstrument = { symbol: string; name: string; market: string };
export type HolderScanStatus = "verified" | "verified-zero" | "failed" | "timeout" | "invalid-source" | "unavailable" | "pending" | "processing";
export type HolderScanRecord = {
  count: number | null;
  status: HolderScanStatus;
  sourceDate: number | null;
  retrievedAt: number | null;
  delivery: "source" | "cache" | "bundled";
  partial: boolean;
  /** Expected Tehran trading session when the request was made; not the source's date. */
  checkedSession?: number | null;
  /** Failed refresh is distinct from the last verified source observation. */
  lastRefreshFailure?: "failed" | "timeout" | "invalid-source" | "unavailable";
  lastRefreshAttemptAt?: number;
};

/** A partial universe is usable; preserve its coverage flag separately. */
export function acceptMarketUniverse(payload: { symbols?: unknown; partial?: boolean }) {
  if (!Array.isArray(payload.symbols)) return { symbols: [] as MarketInstrument[], partial: Boolean(payload.partial) };
  const symbols: MarketInstrument[] = [];
  const seen = new Set<string>();
  for (const item of payload.symbols) {
    if (!item || typeof item !== "object" || typeof item.symbol !== "string") continue;
    const symbol = normalizeSymbol(item.symbol);
    if (!symbol || /^\d+$/.test(symbol) || seen.has(symbol)) continue;
    seen.add(symbol);
    symbols.push({
      symbol,
      name: typeof item.name === "string" ? item.name : "",
      market: typeof item.market === "string" ? item.market : "",
    });
  }
  return { symbols, partial: Boolean(payload.partial) };
}

/** Recover partial source lists without dropping instrument identities already found. */
export function mergeMarketUniverse(previous: MarketInstrument[], incoming: MarketInstrument[]) {
  const merged = new Map(previous.map((item) => [normalizeSymbol(item.symbol), item]));
  const fresh = new Set<string>();
  for (const item of incoming) {
    const symbol = normalizeSymbol(item.symbol);
    if (!symbol) continue;
    fresh.add(symbol);
    const before = merged.get(symbol);
    merged.set(symbol, { symbol, name: item.name || before?.name || "", market: item.market || before?.market || "" });
  }
  return { symbols: [...merged.values()], retained: [...merged.keys()].filter((symbol) => !fresh.has(symbol)).length };
}

export function holderStatus(count: unknown): "verified" | "verified-zero" | "unavailable" {
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0
    ? count === 0 ? "verified-zero" : "verified"
    : "unavailable";
}

export function holderErrorStatus(error: unknown): "timeout" | "failed" {
  return error instanceof Error && (error.name === "TimeoutError" || /مهلت|timeout/i.test(error.message)) ? "timeout" : "failed";
}

/** A failed refresh must preserve its earlier count, date and checked session. */
export function retainHolderOnFailure(
  prior: HolderScanRecord | undefined,
  failure: NonNullable<HolderScanRecord["lastRefreshFailure"]>,
  now: number,
  expectedSession: number | null,
): HolderScanRecord {
  if (prior && (prior.status === "verified" || prior.status === "verified-zero") && prior.status === holderStatus(prior.count)) {
    return { ...prior, delivery: "cache", partial: true, lastRefreshFailure: failure, lastRefreshAttemptAt: now };
  }
  return { count: null, status: failure, sourceDate: null, retrievedAt: now, checkedSession: expectedSession, delivery: "source", partial: true, lastRefreshFailure: failure, lastRefreshAttemptAt: now };
}

/** Previously validated values may be skipped for the *same checked session* only. */
export function pendingHolderSymbols(
  symbols: string[], prior: Record<string, HolderScanRecord>,
  options: { force?: boolean; now: number; expectedSession: number | null; maxAgeMs: number },
) {
  return [...new Set(symbols)].filter((symbol) => {
    if (options.force) return true;
    const r = prior[symbol];
    if (!r || (r.status !== "verified" && r.status !== "verified-zero")) return true;
    if (r.lastRefreshFailure) return true;
    if (r.status !== holderStatus(r.count)) return true;
    if (!r.retrievedAt || !Number.isFinite(r.retrievedAt) || r.retrievedAt > options.now || options.now - r.retrievedAt >= options.maxAgeMs) return true;
    if (r.checkedSession !== options.expectedSession) return true;
    if (r.sourceDate !== null && options.expectedSession !== null && r.sourceDate < options.expectedSession) return true;
    return false;
  });
}

/** A stopped scan must not leave in-flight rows labelled as processing. */
export function releaseProcessingHolders(records: Record<string, HolderScanRecord>) {
  const next = { ...records };
  for (const [symbol, record] of Object.entries(records)) {
    if (record.status === "processing") {
      next[symbol] = { ...record, count: null, status: "pending", partial: true };
    }
  }
  return next;
}
