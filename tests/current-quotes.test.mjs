import assert from "node:assert/strict";
import test from "node:test";
import { instrumentFromClosingPrice, datedCurrentQuotes } from "../app/lib/current-quotes.ts";
import { POST } from "../app/api/screener/route.ts";

const info = { dEven: 20260908, priceMax: 14230, priceMin: 14140, pClosing: 14230, pDrCotVal: 14230, priceFirst: 14210, priceYesterday: 13820, qTotTran5J: 10121604, qTotCap: 144000298800 };
test("official quotes require their own session and actual trades", () => {
  assert.equal(instrumentFromClosingPrice({ closingPriceInfo: info }).Date, 20260908);
  assert.equal(instrumentFromClosingPrice({ closingPriceInfo: { ...info, dEven: 0, finalLastDate: 20260908 } }), null);
  assert.equal(instrumentFromClosingPrice({ closingPriceInfo: { ...info, qTotTran5J: 0 } }), null);
  assert.equal(instrumentFromClosingPrice({ closingPriceInfo: { ...info, pClosing: null } }), null);
});

test("dated official current price supersedes an undated quote and an older daily session", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("daily-batch")) return Response.json({ "کسرام": [{ d_even: 20260907, close: 13820, high: 13820, low: 13820 }] });
    if (String(url).includes("/instruments?")) return Response.json({ "کسرام": { InsCode: "fresh-date-test", Date: 0, Volume: 100, PriceClose: 99999, PriceMin: 99999, PriceMax: 99999 } });
    if (String(url).includes("GetClosingPriceInfo")) return Response.json({ closingPriceInfo: info });
    if (String(url).includes("GetClosingPriceDailyList")) return Response.json({ closingPriceDaily: [] });
    throw new Error(`Unexpected URL ${url}`);
  });
  const result = await (await POST(new Request("http://localhost/api/screener", { method: "POST", body: JSON.stringify({ symbols: ["کسرام"] }) }))).json();
  assert.equal(result.latestDate, 20260908);
  assert.equal(result.rows[0].priceQuote.closeRial, 14230);
  assert.equal(result.rows[0].priceQuote.sessionDate, 20260908);
  assert.equal(result.rows[0].three, null, 'a verified quote is not 90 days of history');
});

test("an unavailable dated quote preserves history and explicitly warns about freshness", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("daily-batch")) return Response.json({ "کسرام": [{ d_even: 20260907, close: 13820, high: 13820, low: 13820 }] });
    if (String(url).includes("/instruments?")) return Response.json({ "کسرام": { InsCode: "failed-date-test", Date: 0, Volume: 100, PriceClose: 99999 } });
    return Response.json({});
  });
  const result = await (await POST(new Request("http://localhost/api/screener", { method: "POST", body: JSON.stringify({ symbols: ["کسرام"] }) }))).json();
  assert.equal(result.latestDate, 20260907);
  assert.equal(result.rows[0].priceQuote.closeRial, 13820);
  assert.equal(result.rows[0].three, null, 'dated price survives without a fabricated period return');
  assert.equal(result.rows[0].status, "warning");
  assert.match(result.rows[0].note, /تازگی قیمت لحظه‌ای تأیید نشد/);
});

test("oversized and malformed screener requests fail before upstream access", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("unexpected upstream access"); });
  for (const symbols of [Array(21).fill("کسرام"), [null], "کسرام"]) {
    const response = await POST(new Request("http://localhost/api/screener", { method: "POST", body: JSON.stringify({ symbols }) }));
    assert.equal(response.status, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test("current official quote tries only the second trusted host after primary HTTP 503", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return String(url).includes("cdn.tsetmc.com")
      ? new Response("<html>503</html>", { status: 503 })
      : Response.json({ closingPriceInfo: { ...info, insCode: "0" } });
  });
  const result = await datedCurrentQuotes(new Map([["کسرام", { InsCode: "quote-alt-20261024" }]]));
  assert.equal(result.get("کسرام")?.PriceClose, 14230);
  assert.equal(result.get("کسرام")?.Date, 20260908);
  assert.equal(result.get("کسرام")?.quoteHost, "tsetmc.com");
  assert.equal(urls.length, 2);
  assert.ok(urls[0].startsWith("https://cdn.tsetmc.com/api/"));
  assert.ok(urls[1].startsWith("https://tsetmc.com/api/"));
});

test("no official host may label an undated or untraded quote as current", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({
    closingPriceInfo: { ...info, dEven: 0, qTotTran5J: 0 },
  }));
  const result = await datedCurrentQuotes(new Map([["نماد", { InsCode: "quote-undated-20261024" }]]));
  assert.equal(result.size, 0);
});
