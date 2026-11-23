/**
 * Explicit, ONE-request diagnostic. No retries, no full-market scan,
 * no request body/headers/response error text written to disk.
 *
 * node --import ./tests/register-typescript.mjs tools/probe-screener-edge-once.mjs --probe --count=20
 */
import { defaultSymbols } from "../app/default-symbols.ts";
import { inspectWorkerEdgeResponse } from "../app/lib/worker-edge-diagnostics.ts";

const countArg = process.argv.find(value => value.startsWith("--count="));
const count = Number(countArg?.slice("--count=".length));
if (!process.argv.includes("--probe") || ![2, 10, 20].includes(count)) {
  console.error("Requires --probe --count=2|10|20 (exactly one request)");
  process.exitCode = 2;
} else {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 22_000);
  try {
    const response = await fetch("https://iran-stock-screener.ar-nikzad09.workers.dev/api/screener", {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
      body: JSON.stringify({ symbols: defaultSymbols.slice(0, count), baseOnly: true }),
      signal: controller.signal,
    });
    const failed = response.status >= 500
      ? await inspectWorkerEdgeResponse(response.clone()) : null;
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 1_500_000) throw Error("RESPONSE_LIMIT_1_5MB");
    let parsed;
    if (response.ok) {
      try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
      catch { parsed = null; }
    }
    console.log(JSON.stringify({
      checkedSymbols: count, httpStatus: response.status, elapsedMs: Date.now() - started,
      bytes: bytes.byteLength, cloudflare: failed,
      validPriceCount: typeof parsed?.coverage?.quoted === "number" ? parsed.coverage.quoted : null,
      noTradeRejected: typeof parsed?.coverage?.rejectedNoTrade === "number" ? parsed.coverage.rejectedNoTrade : null,
      partial: typeof parsed?.partial === "boolean" ? parsed.partial : null,
      note: "A successful response does not prove an intermittent 503 is fixed.",
    }, null, 2));
  } catch {
    console.log(JSON.stringify({ checkedSymbols: count, httpStatus: null,
      elapsedMs: Date.now() - started, failure: controller.signal.aborted ? "timeout" : "network-or-response-limit" }));
    process.exitCode = 1;
  } finally { clearTimeout(timer); }
}
