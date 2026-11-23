import test from "node:test";
import assert from "node:assert/strict";
import { BASE_ONLY_FEED_TIMEOUTS, POST } from "../app/api/screener/route.ts";

const datedInstrument = {
  InsCode: "123456", Date: 20261021, PriceMax: 101, PriceMin: 99,
  PriceClose: 100, PriceLast: 100, PriceYesterday: 99, Volume: 1000,
};

test("list feed deadlines leave room for the 18-second browser recovery window", () => {
  assert.ok(BASE_ONLY_FEED_TIMEOUTS.daily < 18_000);
  assert.ok(BASE_ONLY_FEED_TIMEOUTS.instruments <= BASE_ONLY_FEED_TIMEOUTS.daily);
});

test("upstream HTML 503 cannot erase an independently dated instrument or turn a missing symbol into zero", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (String(url).includes("/instruments?")) return Response.json({ "الف": datedInstrument });
    if (String(url).includes("/daily-batch?")) return new Response("<html>upstream unavailable</html>", { status: 503, headers: { "content-type": "text/html" } });
    throw new Error("Unexpected optional official fetch");
  });
  const response = await POST(new Request("http://localhost/api/screener", {
    method: "POST", body: JSON.stringify({ symbols: ["الف", "ب"], baseOnly: true }),
  }));
  assert.equal(response.status, 200);
  assert.match(response.headers.get("server-timing") ?? "", /^market_feeds;dur=\d+,market_analysis;dur=\d+$/);
  assert.match(response.headers.get("content-type"), /application\/json/);
  const data = await response.json();
  assert.equal(data.latestDate, 20261021);
  assert.equal(data.coverage.computed, 0, 'a one-session quote lacks a 90/180-day baseline');
  assert.equal(data.coverage.missingPrices, 1);
  assert.equal(data.freshness.requested, 2);
  assert.equal(data.freshness.dated, 1);
  assert.equal(data.freshness.missing, 1);
  assert.equal(data.freshness.calendarOnly, true);
  assert.equal(data.partial, true);
  assert.equal(data.rows.find((row) => row.symbol === "الف").priceQuote.closeRial, 100);
  assert.equal(data.rows.find((row) => row.symbol === "الف").three, null);
  assert.equal(data.rows.find((row) => row.symbol === "الف").quoteVerified, false,
    "A Zarvan-only instrument is not independent official verification");
  const missing = data.rows.find((row) => row.symbol === "ب");
  assert.equal(missing.status, "error");
  assert.equal(missing.three, null);
  assert.match(missing.note, /ناموفق/);
  assert.ok(data.diagnostics.some((d) => d.code === "PROVIDER_HTTP_ERROR" && d.status === 503));
  assert.ok(calls.every((url) => url.includes("zarvanfund.ir")));
});

test("twenty-symbol base batch does not run extra official corporate-action subrequests", async (t) => {
  const symbols = Array.from({ length: 20 }, (_, index) => `نماد${index}`);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (String(url).includes("/instruments?")) return Response.json(Object.fromEntries(symbols.map((symbol) => [symbol, { ...datedInstrument, InsCode: symbol }])));
    if (String(url).includes("/daily-batch?")) return Response.json(Object.fromEntries(symbols.map((symbol) => [symbol, [
      { d_even: 20261020, close: 1000, high: 1000, low: 1000, yesterday: 1000 },
      { d_even: 20261021, close: 400, high: 400, low: 400 },
    ]])));
    throw new Error("Base-only request must not call official network");
  });
  const response = await POST(new Request("http://localhost/api/screener", {
    method: "POST", body: JSON.stringify({ symbols, baseOnly: true }),
  }));
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.rows.length, 20);
  assert.equal(data.officialVerification, "deferred-to-browser");
  assert.match(data.source, /deferred/);
  assert.ok(data.rows.every((row) => row.quoteVerified === false),
    "baseOnly must never claim TSETMC verification from a Zarvan dated snapshot");
  assert.ok(calls.every((url) => url.includes("zarvanfund.ir")));
  assert.ok(data.rows.every((row) => row.status !== "ready"), "unconfirmed 60% scale breaks remain warnings");
});
