import test from "node:test";
import assert from "node:assert/strict";
import { recoverDatedScreenerBatch } from "../app/lib/screener-direct-recovery.ts";
import { screenerQuoteSession, summarizeScreenerFreshness } from "../app/lib/screener-freshness.ts";

const compact = (i) => {
  const date = new Date(Date.UTC(2026, 0, i + 1));
  return Number(date.toISOString().slice(0, 10).replaceAll("-", ""));
};

test("browser recovery preserves dated close despite both 90/180 returns being blocked by unresolved scale gap", async () => {
  const candles = Array.from({ length: 100 }, (_, i) => {
    const close = i === 99 ? 400 : 1000;
    return { d_even: compact(i), close, high: close, low: close, last: close };
  });
  const request = async (url) => String(url).includes("/daily-batch?")
    ? Response.json({ "آزمون": candles })
    : Response.json({ "آزمون": { InsCode: "123", Date: 0, Eps: 10, Pe: 5, SectorPE: 50 } });
  const result = await recoverDatedScreenerBatch(["آزمون"], new AbortController().signal, request);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].three, null);
  assert.equal(result.rows[0].six, null);
  assert.deepEqual(result.rows[0].priceQuote, { closeRial: 400, sessionDate: compact(99) });
  assert.equal(result.latestDate, compact(99));
  assert.equal(result.rows[0].status, "warning");
  assert.equal(result.rows[0].valuation.epsSectorPePrice, 500);
  assert.equal(result.rows[0].valuation.epsSectorPeUpsidePct, 25);
});

test("unusable dates and histories remain unavailable, never fabricated as a quote", async () => {
  const request = async (url) => String(url).includes("/daily-batch?")
    ? Response.json({ "آزمون": [{ d_even: 20300101, close: 100, high: 100, low: 100 }] })
    : Response.json({});
  await assert.rejects(recoverDatedScreenerBatch(["آزمون"], new AbortController().signal, request), /هیچ سابقه قیمت/);
});

test("per-symbol freshness distinguishes source dates, missing data and calendar-only assumptions", () => {
  const now = new Date("2026-10-24T11:00:00Z");
  const rows = [
    { symbol: "فولاد", priceQuote: { closeRial: 4110, sessionDate: 20261024 } },
    { symbol: "کسرام", priceQuote: { closeRial: 18570, sessionDate: 20261021 } },
    { symbol: "کسرا", priceQuote: { closeRial: 2458, sessionDate: 20261021 }, three: null, six: null },
    { symbol: "بدون", priceQuote: null, three: null, six: null },
  ];
  assert.equal(screenerQuoteSession(rows[2], now), 20261021);
  assert.equal(screenerQuoteSession(rows[3], now), null);
  assert.deepEqual(summarizeScreenerFreshness(rows, 20261024, now), {
    requested: 4, dated: 3, missing: 1, atCalendar: 1,
    earlierThanCalendar: 2, expectedCalendarSession: 20261024, calendarOnly: true,
  });
});

test("invalid prices and future dates never become fresh simply because request is recent", () => {
  const now = new Date("2026-10-24T11:00:00Z");
  assert.equal(screenerQuoteSession({ priceQuote: { sessionDate: 20261024, closeRial: 0 } }, now), null);
  assert.equal(screenerQuoteSession({ priceQuote: { sessionDate: 20261025, closeRial: 100 } }, now), null);
});
