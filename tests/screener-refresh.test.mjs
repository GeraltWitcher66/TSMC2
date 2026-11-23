import test from "node:test";
import assert from "node:assert/strict";
import { markScreenerRowsStale, SCREENER_AUTO_REFRESH_INTERVAL_MS, shouldAutoRefreshScreener } from "../app/lib/screener-refresh.ts";

test("automatic price refresh is limited to visible 3m/6m tabs and never overlaps a load", () => {
  assert.equal(SCREENER_AUTO_REFRESH_INTERVAL_MS, 300_000);
  assert.equal(shouldAutoRefreshScreener("3m", true, false), true);
  assert.equal(shouldAutoRefreshScreener("6m", true, false), true);
  assert.equal(shouldAutoRefreshScreener("holders", true, false), false);
  assert.equal(shouldAutoRefreshScreener("3m", false, false), false);
  assert.equal(shouldAutoRefreshScreener("3m", true, true), false);
});

test("failed refresh preserves source dates and values while marking prior rows stale", () => {
  const rows = [{ symbol: "آزمون", status: "ready", priceQuote: { closeRial: 1234, sessionDate: 20261114 } }];
  const stale = markScreenerRowsStale(rows, "بروزرسانی تازه ناموفق بود.");
  assert.equal(stale[0].status, "warning");
  assert.equal(stale[0].priceQuote.closeRial, 1234);
  assert.equal(stale[0].priceQuote.sessionDate, 20261114);
  assert.match(stale[0].note, /20261114/);
  assert.equal(rows[0].status, "ready", "input rows remain immutable");
});
