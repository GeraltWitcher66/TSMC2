/**
 * A deliberately small, privacy-safe diagnostic for intermittent Cloudflare
 * errors. It must never log request bodies, query strings, cookies, or raw
 * upstream error pages. The Cloudflare 1xxx *code* is kept only when seen.
 */
export type WorkerEdgeDiagnostic = {
  httpStatus: number;
  cfRay: string | null;
  cloudflareCode: number | null;
  contentKind: "json" | "html" | "text" | "other";
};

const cfCodeFrom = (value: string): number | null => {
  const match = value.match(/(?:cloudflare-1xxx-errors\/error-|\b(?:error|code)\D{0,8})(1\d{3})\b/i);
  return match ? Number(match[1]) : null;
};

const readPrefix = async (response: Response, limit = 4096): Promise<string> => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let used = 0;
  try {
    while (used < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const length = Math.min(value.byteLength, limit - used);
      chunks.push(value.subarray(0, length));
      used += length;
    }
  } finally {
    // Error bodies are diagnostic only, and are not needed by the fallback.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const result = new Uint8Array(used);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(result);
};

export async function inspectWorkerEdgeResponse(response: Response): Promise<WorkerEdgeDiagnostic> {
  const type = (response.headers.get("content-type") ?? "").toLowerCase();
  const contentKind: WorkerEdgeDiagnostic["contentKind"] =
    type.includes("json") ? "json" : type.includes("html") ? "html" : type.includes("text") ? "text" : "other";
  const ray = response.headers.get("cf-ray");
  // A Ray ID is a correlation identifier, not a source for a geolocation
  // or an assertion about the underlying cause.
  const cfRay = ray && /^[A-Za-z0-9-]{5,80}$/.test(ray) ? ray : null;
  let cloudflareCode: number | null = null;
  if ([500, 502, 503, 504].includes(response.status)) {
    const prefix = await readPrefix(response).catch(() => "");
    if (contentKind === "json") {
      try {
        const payload: unknown = JSON.parse(prefix);
        if (payload && typeof payload === "object" && !Array.isArray(payload)) {
          const p = payload as Record<string, unknown>;
          // Numeric 1xxx code in a structured Cloudflare error, or from
          // its advertised documentation URL. Do not infer 1102 from 503.
          if (typeof p.code === "number" && p.code >= 1000 && p.code <= 1999 && Number.isInteger(p.code)) cloudflareCode = p.code;
          else if (typeof p.type === "string") cloudflareCode = cfCodeFrom(p.type);
          else if (typeof p.title === "string") cloudflareCode = cfCodeFrom(p.title);
        }
      } catch { /* Could be a truncated or non-JSON edge page. */ }
    }
    cloudflareCode ??= cfCodeFrom(prefix);
  }
  return { httpStatus: response.status, cfRay, cloudflareCode, contentKind };
}

/**
 * Per-refresh, bounded Worker-only circuit breaker. A recovered Worker/edge
 * 502/503/504 or transport timeout is evidence that the direct dated provider
 * is working and the Worker path is impaired. For a normal 178-symbol load,
 * skip the Worker for the remaining 17 small batches, not merely two batches
 * followed by more failing Worker requests. A new user refresh gets a fresh
 * instance; failed direct CORS immediately re-enables the Worker.
 */
export class ScreenerWorkerCircuitBreaker {
  private remainingDirectBatches = 0;

  constructor(private readonly bypassCount = 17) {}

  shouldTryDirectFirst(): boolean {
    if (this.remainingDirectBatches === 0) return false;
    this.remainingDirectBatches--;
    return true;
  }

  recoveredFromWorkerFailure(): void {
    this.remainingDirectBatches = this.bypassCount;
  }

  workerSucceeded(): void {
    this.remainingDirectBatches = 0;
  }

  directSourceFailed(): void {
    // Fail open to the Worker if the CORS recovery path stops working.
    this.workerSucceeded();
  }
}
