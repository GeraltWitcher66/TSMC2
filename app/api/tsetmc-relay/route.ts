// Relay for official TSETMC endpoints.
//
// Some Cloudflare egress locations cannot reach cdn.tsetmc.com (documented in
// QA_REPORT.md), and users behind foreign VPN exits cannot reach TSETMC from
// the browser either. This route lets the browser ask this Worker to relay the
// request, trying every official TSETMC hostname in turn, and keeps a short
// shared-cache copy so one successful upstream fetch serves many visitors.
//
// Only read-only market-data endpoints are allowed; the upstream host is fixed
// and the path is validated, so this can never be abused as an open proxy.

import { upstreamJson, type UpstreamDiagnostic } from "../../lib/upstream";
import { validOfficialDatedPayload } from "../../lib/official-details";

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

// Browser-like headers; TSETMC rejects requests that look like scripts.
const TSETMC_HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  Referer: "https://tsetmc.com/",
};

const CACHE_TTL_SECONDS = 45;
const FAILURE_THRESHOLD = 2;
const HOST_COOLDOWN_MS = 15_000;
const hostHealth = new Map<string, { failures: number; blockedUntil: number }>();

/** Suppress repeated requests to a failing host without suppressing the healthy alternative. */
export function relayHostAvailable(host: string, now = Date.now()) {
  return (hostHealth.get(host)?.blockedUntil ?? 0) <= now;
}

export function recordRelayHostResult(host: string, succeeded: boolean, now = Date.now()) {
  if (succeeded) { hostHealth.delete(host); return; }
  const current = hostHealth.get(host);
  const failures = (current?.blockedUntil && current.blockedUntil <= now ? 0 : current?.failures ?? 0) + 1;
  hostHealth.set(host, { failures, blockedUntil: failures >= FAILURE_THRESHOLD ? now + HOST_COOLDOWN_MS : 0 });
}

export function isAllowedTsetmcPath(path: string) {
  return !/[\\%?#]/.test(path) && !path.includes("..") && ALLOWED_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/** Try every official TSETMC hostname in turn; return the raw text or null. */
export async function fetchTsetmcViaHosts(path: string, signal?: AbortSignal, observe?: (event: UpstreamDiagnostic) => void, request: typeof fetch = fetch): Promise<string | null> {
  if (!isAllowedTsetmcPath(path)) return null;
  for (const host of TSETMC_HOSTS) {
    if (signal?.aborted) return null;
    if (!relayHostAvailable(host)) continue;
    try {
      const payload = await upstreamJson(`https://${host}/api/${path}`, {
        headers: TSETMC_HEADERS,
        signal, timeoutMs: 8_000, observe, request,
      });
      // HTTP 200 with an empty/wrong-session record is not a successful
      // ClientType/floor lookup. Try the other host without caching the payload.
      // Missing data for one instrument is not evidence the host is unhealthy.
      if (!validOfficialDatedPayload(path, payload)) continue;
      recordRelayHostResult(host, true);
      return JSON.stringify(payload);
    } catch {
      if (signal?.aborted) return null;
      recordRelayHostResult(host, false);
      // Try the next official hostname.
    }
  }
  return null;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const path = (url.searchParams.get("path") ?? "").replace(/^\/+/, "");

  if (!isAllowedTsetmcPath(path)) {
    return Response.json({ error: "مسیر درخواستی مجاز نیست." }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }

  // The Workers Cache API is runtime-provided and absent from the default TS lib.
  const cache = (globalThis as unknown as { caches?: { default: Cache } }).caches?.default ?? null;
  const cacheKey = new Request(`https://relay.local/${path}`, { headers: request.headers });
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  const diagnostics: UpstreamDiagnostic[] = [];
  const body = await fetchTsetmcViaHosts(path, request.signal, (event) => { diagnostics.push(event); });
  if (body === null) {
    return Response.json(
      { error: "منبع رسمی TSETMC از هیچ مسیری در دسترس نیست.", diagnostics },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }

  const response = new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "Access-Control-Allow-Origin": "*",
    },
  });
  if (cache) {
    await cache.put(cacheKey, response.clone()).catch(() => {});
  }
  return response;
}
