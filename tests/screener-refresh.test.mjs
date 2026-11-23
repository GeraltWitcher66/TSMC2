import test from "node:test";
import assert from "node:assert/strict";
import {
  markScreenerRowsStale, nextScreenerRefreshAt, screenerNeedsRefresh,
  SCREENER_MAX_VERIFICATION_ATTEMPTS, SCREENER_VERIFICATION_RETRY_MS,
} from "../app/lib/screener-refresh.ts";

// Iran is UTC+3:30, so 14:00 Tehran is 10:30 UTC.
const tehran = (iso) => new Date(`${iso}+03:30`);
const row = (symbol, sessionDate, extra = {}) => ({
  symbol, rsi: null, realHolders: null, three: null, six: null, actions: [], status: "ready",
  priceQuote: { closeRial: 1000, sessionDate }, ...extra,
});

test("an open page refreshes only when the session moved or a row still needs one bounded retry", () => {
  const monday = tehran("2026-11-23T14:00:00");
  const rows = [row("الف", 20261123, { quoteVerified: true }), row("ب", 20261123, { quoteVerified: true })];
  assert.equal(screenerNeedsRefresh(rows, monday, { loadedSession: 20261123 }), false);

  // Before the next 13:00 close the expected session is still Monday.
  assert.equal(screenerNeedsRefresh(rows, tehran("2026-11-24T10:00:00"), { loadedSession: 20261123 }), false);
  // After the close the expected session advances to Tuesday.
  assert.equal(screenerNeedsRefresh(rows, tehran("2026-11-24T13:10:00"), { loadedSession: 20261123 }), true);

  // Thursday and Friday have no equity session of their own.
  const wednesday = [row("الف", 20261125, { quoteVerified: true })];
  assert.equal(screenerNeedsRefresh(wednesday, tehran("2026-11-26T10:00:00"), { loadedSession: 20261125 }), false);
  assert.equal(screenerNeedsRefresh(wednesday, tehran("2026-11-26T20:00:00"), { loadedSession: 20261125 }), false);
  assert.equal(screenerNeedsRefresh(wednesday, tehran("2026-11-27T20:00:00"), { loadedSession: 20261125 }), false);
});

test("a halted symbol and an exhausted attempt budget stop the automatic refresh", () => {
  const now = tehran("2026-11-24T14:00:00");
  const rows = [row("الف", 20261124, { quoteVerified: true }), row("متوقف", 20261118)];
  assert.equal(screenerNeedsRefresh(rows, now, { loadedSession: 20261124 }), false, "older official session is settled");

  const pending = [row("الف", 20261124), row("ب", 20261124)];
  assert.equal(screenerNeedsRefresh(pending, now, { loadedSession: 20261124 }), true, "first attempt has no budget record yet");
  assert.equal(screenerNeedsRefresh(pending, now, {
    loadedSession: 20261124,
    verification: { session: 20261124, attempts: 1, lastAttemptAt: now.getTime() - 60_000 },
  }), false, "a retry waits ten minutes");
  assert.equal(screenerNeedsRefresh(pending, now, {
    loadedSession: 20261124,
    verification: { session: 20261124, attempts: 1, lastAttemptAt: now.getTime() - SCREENER_VERIFICATION_RETRY_MS },
  }), true);
  assert.equal(screenerNeedsRefresh(pending, now, {
    loadedSession: 20261124,
    verification: { session: 20261124, attempts: SCREENER_MAX_VERIFICATION_ATTEMPTS, lastAttemptAt: now.getTime() - 10 * SCREENER_VERIFICATION_RETRY_MS },
  }), false, "the budget for this session is spent");

  assert.equal(screenerNeedsRefresh([], now, {}), true);
  assert.equal(screenerNeedsRefresh([row("الف", 20261124, { quoteVerified: true })], now, { loadedSession: null }), true);
});

test("the next timer waits for Saturday 13:05 after Wednesday evening", () => {
  assert.equal(nextScreenerRefreshAt(tehran("2026-11-25T20:00:00")).toISOString(), "2026-11-28T09:35:00.000Z");
  // A running session still refreshes at its own close.
  assert.equal(nextScreenerRefreshAt(tehran("2026-11-23T09:00:00")).toISOString(), "2026-11-23T09:35:00.000Z");
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
