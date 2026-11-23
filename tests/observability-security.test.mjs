import test from "node:test";
import assert from "node:assert/strict";
import { safeDiagnosticPath } from "../app/lib/upstream.ts";

test("upstream diagnostics retain static paths but mask unknown URL credentials", () => {
  assert.equal(safeDiagnosticPath(new URL("https://zarvanfund.ir/api/daily-batch?syms=PRIVATE")), "/api/daily-batch");
  assert.equal(safeDiagnosticPath(new URL("https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceInfo/65883838195688438")), "/api/ClosingPrice/GetClosingPriceInfo/:id");
  assert.equal(safeDiagnosticPath(new URL("https://streamdata.ir/api/chart/v1/privateToken123/history?symbol=PRIVATE")), "/[redacted]");
  assert.equal(safeDiagnosticPath(new URL("https://unknown.example/private-secret")), "/[redacted]");
});
