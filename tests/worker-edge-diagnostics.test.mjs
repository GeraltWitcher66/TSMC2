import test from "node:test";
import assert from "node:assert/strict";
import { inspectWorkerEdgeResponse, ScreenerWorkerCircuitBreaker } from "../app/lib/worker-edge-diagnostics.ts";

test("preserves observed Cloudflare code and ray while redacting message, URL and secrets", async () => {
  const response = Response.json({
    type: "https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/",
    title: "Worker exceeded resource limits",
    detail: "token=secret&symbol=private",
  }, { status: 503, headers: { "cf-ray": "a4fb4d7e2c579886-FRA" } });
  const report = await inspectWorkerEdgeResponse(response);
  assert.deepEqual(report, { httpStatus: 503, cfRay: "a4fb4d7e2c579886-FRA", cloudflareCode: 1102, contentKind: "json" });
  assert.doesNotMatch(JSON.stringify(report), /token|secret|private|symbol|detail/i);
});

test("generic 503 must not be mislabeled Cloudflare 1102", async () => {
  const errorPage = new Response("<html><h1>Upstream unavailable</h1></html>", {
    status: 503, headers: { "Content-Type": "text/html" },
  });
  const report = await inspectWorkerEdgeResponse(errorPage);
  assert.deepEqual(report, { httpStatus: 503, cfRay: null, cloudflareCode: null, contentKind: "html" });
});

test("HTML with explicit observed Cloudflare numeric error retains only code", async () => {
  const response = new Response("<html>Error 1105: Worker not found; user id=private</html>", {
    status: 503, headers: { "Content-Type": "text/html", "cf-ray": "malicious-path?secret" },
  });
  const report = await inspectWorkerEdgeResponse(response);
  assert.equal(report.cloudflareCode, 1105);
  assert.equal(report.cfRay, null);
});

test("malformed json Cloudflare error and 200 response never leak untrusted contents", async () => {
  const invalid = new Response('{"type":"https://developers.cloudflare.com/cloudflare-1xxx-errors/error-1101/"', {
    status: 503, headers: { "Content-Type": "application/problem+json" },
  });
  assert.equal((await inspectWorkerEdgeResponse(invalid)).cloudflareCode, 1101);
  const success = new Response('{"code":1102}', { status: 200, headers: { "Content-Type": "application/json" } });
  assert.deepEqual(await inspectWorkerEdgeResponse(success), {
    httpStatus: 200, cfRay: null, cloudflareCode: null, contentKind: "json",
  });
});

test("limited prefix reader stops oversized error body", async () => {
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("Error 1102 " + "s".repeat(100_000)));
    },
    cancel() {},
  }), { status: 503, headers: { "Content-Type": "text/html" } });
  assert.equal((await inspectWorkerEdgeResponse(response)).cloudflareCode, 1102);
});

test("one recovered edge failure bypasses the remaining seventeen serial Worker batches", () => {
  const breaker = new ScreenerWorkerCircuitBreaker();
  assert.equal(breaker.shouldTryDirectFirst(), false);
  breaker.recoveredFromWorkerFailure();
  for (let i = 0; i < 17; i++) assert.equal(breaker.shouldTryDirectFirst(), true);
  assert.equal(breaker.shouldTryDirectFirst(), false);
  breaker.workerSucceeded();
  assert.equal(breaker.shouldTryDirectFirst(), false);
  assert.equal(new ScreenerWorkerCircuitBreaker().shouldTryDirectFirst(), false, "a new refresh gets a new breaker");
});

test("unavailable direct-source fallback restores Worker immediately", () => {
  const breaker = new ScreenerWorkerCircuitBreaker();
  breaker.recoveredFromWorkerFailure();
  assert.equal(breaker.shouldTryDirectFirst(), true);
  breaker.directSourceFailed();
  assert.equal(breaker.shouldTryDirectFirst(), false);
});
