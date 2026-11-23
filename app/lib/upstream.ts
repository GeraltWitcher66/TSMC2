import { withDeadline } from "./request-lifecycle";

export type UpstreamCode = "PROVIDER_HTTP_403" | "PROVIDER_HTTP_500" | "PROVIDER_HTTP_ERROR" | "PROVIDER_INVALID_RESPONSE" | "PROVIDER_SCHEMA_MISMATCH" | "REQUEST_TIMEOUT" | "REQUEST_CANCELLED" | "UPSTREAM_NETWORK_FAILURE";
export type UpstreamDiagnostic = {
  code: UpstreamCode | "OK"; host: string; path: string;
  stage: "headers" | "body" | "parse" | "schema" | "complete";
  status?: number; contentType?: string; headersMs?: number; durationMs: number;
};

/** Failure telemetry intentionally names only known public endpoint routes,
 * never dynamic path segments: future providers may put bearer tokens in URLs.
 * Query strings were already excluded. */
export function safeDiagnosticPath(url: URL): string {
  if (url.hostname === "zarvanfund.ir") {
    if (url.pathname === "/api/instruments" || url.pathname === "/api/daily-batch") return url.pathname;
  }
  if (["cdn.tsetmc.com", "tsetmc.com", "cdn10.tsetmc.com"].includes(url.hostname)) {
    const match = url.pathname.match(/^\/api\/(ClosingPrice|Instrument)\/(GetClosingPriceInfo|GetClosingPriceDailyList|GetInstrumentShareChange)(?:\/.*)?$/);
    if (match) return "/api/" + match[1] + "/" + match[2] + "/:id";
  }
  return "/[redacted]";
}
export class UpstreamError extends Error {
  constructor(public diagnostic: UpstreamDiagnostic) {
    super(diagnostic.code === "REQUEST_TIMEOUT" ? "مهلت دریافت از منبع داده تمام شد." : `دریافت منبع داده ناموفق بود (${diagnostic.code}).`);
    this.name = "UpstreamError";
  }
}
export function diagnosticOf(error: unknown) {
  return error instanceof UpstreamError ? error.diagnostic : undefined;
}

/** One bounded attempt. Logs contain endpoint identity and timings, never query values, headers or bodies. */
export async function upstreamJson<T = unknown>(url: string, options: {
  timeoutMs: number; signal?: AbortSignal; headers?: HeadersInit;
  validate?: (value: unknown) => boolean; observe?: (event: UpstreamDiagnostic) => void;
  request?: typeof fetch;
}): Promise<T> {
  const target = new URL(url), started = Date.now();
  const diagnostic: UpstreamDiagnostic = { code: "OK", host: target.hostname, path: safeDiagnosticPath(target), stage: "headers", durationMs: 0 };
  try {
    return await withDeadline(async (signal) => {
      const response = await (options.request ?? fetch)(url, { headers: options.headers ?? { Accept: "application/json" }, signal });
      signal.throwIfAborted();
      diagnostic.headersMs = Date.now() - started;
      diagnostic.status = response.status;
      diagnostic.contentType = response.headers.get("content-type") ?? "";
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        diagnostic.code = response.status === 403 ? "PROVIDER_HTTP_403" : response.status === 500 ? "PROVIDER_HTTP_500" : "PROVIDER_HTTP_ERROR";
        throw new UpstreamError(diagnostic);
      }
      diagnostic.stage = "body";
      const body = await response.text();
      signal.throwIfAborted();
      diagnostic.stage = "parse";
      let payload: unknown;
      try { payload = JSON.parse(body); } catch {
        diagnostic.code = "PROVIDER_INVALID_RESPONSE";
        throw new UpstreamError(diagnostic);
      }
      diagnostic.stage = "schema";
      if (options.validate && !options.validate(payload)) {
        diagnostic.code = "PROVIDER_SCHEMA_MISMATCH";
        throw new UpstreamError(diagnostic);
      }
      diagnostic.stage = "complete";
      return payload as T;
    }, options.timeoutMs, options.signal);
  } catch (error) {
    if (!(error instanceof UpstreamError)) {
      diagnostic.code = options.signal?.aborted ? "REQUEST_CANCELLED"
        : error instanceof Error && error.name === "TimeoutError" ? "REQUEST_TIMEOUT" : "UPSTREAM_NETWORK_FAILURE";
    }
    throw new UpstreamError({ ...diagnostic, durationMs: Date.now() - started });
  } finally {
    diagnostic.durationMs = Date.now() - started;
    options.observe?.({ ...diagnostic });
    // A transport failure alone cannot establish DNS, TLS, IP blocking, or a Cloudflare-specific fault.
    if (diagnostic.code !== "OK") console.warn(JSON.stringify({ event: "market_upstream", ...diagnostic }));
  }
}
