import { upstreamJson, type UpstreamDiagnostic } from "../../../app/lib/upstream";
import { validOfficialDatedPayload } from "../../../app/lib/official-details";
import { readCache, writeCache } from "./cache";

/**
 * Read-only relay for the official TSETMC endpoints. It tries each official
 * host in turn, keeps a short shared cache, and refuses every other path so it
 * can never be used as an open proxy.
 */

const ALLOWED_PREFIXES = [
  "ClosingPrice/GetClosingPriceInfo/",
  "ClosingPrice/GetClosingPriceDailyList/",
  "Instrument/GetInstrumentShareChange/",
  "Instrument/GetInstrumentInfo/",
  "ClientType/GetClientTypeAll",
  "ClientType/GetClientTypeHistory/",
  "MarketData/GetStaticThreshold/",
  "ShareHolder/GetShareHolderChanges",
  "Shareholder/GetShareHolderChanges",
] as const;

const TSETMC_HOSTS = ["cdn.tsetmc.com", "tsetmc.com"] as const;
const CACHE_TTL_MS = 45_000;
const FAILURE_THRESHOLD = 2;
const HOST_COOLDOWN_MS = 15_000;
const hostHealth = new Map<string, { failures: number; blockedUntil: number }>();

export function relayHostAvailable(host: string, now = Date.now()) {
  return (hostHealth.get(host)?.blockedUntil ?? 0) <= now;
}

export function recordRelayHostResult(host: string, succeeded: boolean, now = Date.now()) {
  if (succeeded) {
    hostHealth.delete(host);
    return;
  }
  const current = hostHealth.get(host);
  const failures = (current?.blockedUntil && current.blockedUntil <= now ? 0 : current?.failures ?? 0) + 1;
  hostHealth.set(host, { failures, blockedUntil: failures >= FAILURE_THRESHOLD ? now + HOST_COOLDOWN_MS : 0 });
}

export function isAllowedTsetmcPath(path: string) {
  return !/[\\%?#]/.test(path) && !path.includes("..") && ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Try every official hostname in turn; return the raw text or null. */
export async function fetchTsetmcViaHosts(
  path: string,
  signal?: AbortSignal,
  observe?: (event: UpstreamDiagnostic) => void,
): Promise<string | null> {
  if (!isAllowedTsetmcPath(path)) return null;
  const cached = readCache(`relay:${path}`);
  if (cached) return cached;
  for (const host of TSETMC_HOSTS) {
    if (signal?.aborted) return null;
    if (!relayHostAvailable(host)) continue;
    try {
      const payload = await upstreamJson(`https://${host}/api/${path}`, {
        signal,
        timeoutMs: 8_000,
        observe,
      });
      if (!validOfficialDatedPayload(path, payload)) continue;
      recordRelayHostResult(host, true);
      const body = JSON.stringify(payload);
      writeCache(`relay:${path}`, body, CACHE_TTL_MS);
      return body;
    } catch {
      if (signal?.aborted) return null;
      recordRelayHostResult(host, false);
    }
  }
  return null;
}
