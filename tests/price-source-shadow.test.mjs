import assert from "node:assert/strict";
import test from "node:test";
import {
  priceIdentity, fromZarvanDaily, fromTsetmcCurrent,
  fromTseWebgwHistory, comparePriceSources,
} from "../app/lib/price-source-shadow.ts";
import { compactScreenerCandle, POST } from "../app/api/screener/route.ts";
import { isClosedScreenerSession, validSourceDailyPrice, instrumentFromDailyRows, validHighlightSnapshotSession } from "../app/lib/market-session.ts";

const now = new Date("2026-10-24T16:00:00Z");
const raw = { Symbol: "خودرو", InsCode: "65883838195688438", ISIN: "IRO1IKCO0001", Date: 0, Time: 123000, PriceClose: 659 };
const identity = priceIdentity(raw, "خودرو");
const daily = (date, close, extra = {}) => ({
  d_even: date, close, high: close + 5, low: close - 5, open: close,
  last: close, yesterday: close, volume: 1000, ...extra,
});
const tsetmc = (date, close, extra = {}) => ({
  closingPriceInfo: { dEven: date, insCode: 0, pClosing: close,
    priceMax: close + 5, priceMin: close - 5, priceFirst: close,
    pDrCotVal: close, qTotTran5J: 1000, ...extra },
});
const webgw = (date, close, extra = {}) => [{
  instrumentid: identity.isin, devenrlc: date,
  closingprice: { value: close, state: "ok" },
  highvalue: { value: close + 5, state: "ok" },
  lowvalue: { value: close - 5, state: "ok" },
  lastprice: { value: close, state: "ok" },
  firstPrice: { value: close, state: "ok" },
  tradevolume: { value: 1000, state: "ok" }, ...extra,
}];

test("symbol and both identifiers must be mapped without losing 17-digit InsCode precision", () => {
  assert.deepEqual(identity, { symbol: "خودرو", insCode: "65883838195688438", isin: "IRO1IKCO0001" });
  assert.equal(priceIdentity({ ...raw, Symbol: "فولاد" }, "خودرو"), null);
  assert.equal(priceIdentity({ ...raw, InsCode: Number(raw.InsCode) }, "خودرو"), null);
  assert.equal(priceIdentity({ ...raw, ISIN: null }, "خودرو").isin, null);
});

test("Zarvan Date=0 snapshot never becomes an inferred 20261024 candle", () => {
  const old = fromZarvanDaily(identity, [daily(20261021, 679)], now);
  assert.equal(old.sessionDate, 20261021);
  assert.equal(old.closeRial, 679);
  assert.equal(old.source, "zarvan-daily");
  assert.equal(fromZarvanDaily(identity, { Date: 0, Time: 123000, PriceClose: 659 }, now), null);
  assert.equal(fromZarvanDaily(identity, [daily(20261025, 659)], now), null);
});

test("newer independently dated TSETMC quote is only shadow-observed, never silently merged", () => {
  const base = fromZarvanDaily(identity, [daily(20261021, 679)], now);
  const alt = fromTsetmcCurrent(identity, tsetmc(20261024, 659), now);
  const result = comparePriceSources(base, alt);
  assert.equal(result.status, "alternative-newer");
  assert.equal(result.daysAhead, 3);
  assert.equal(base.closeRial, 679);
  assert.equal(alt.closeRial, 659);
  assert.equal(alt.adjustmentBasis, "unknown");
});

test("dated webgw ISIN archive compares exactly after unwrapping documented value/state fields", () => {
  const base = fromZarvanDaily(identity, [daily(20261024, 659)], now);
  const alt = fromTseWebgwHistory(identity, webgw(20261024, 659), now);
  assert.equal(alt.source, "tse-webgw-history");
  assert.equal(alt.identity.isin, "IRO1IKCO0001");
  assert.equal(comparePriceSources(base, alt).status, "same-date-match");
  assert.equal(comparePriceSources(base, fromTseWebgwHistory(identity, webgw(20261024, 660), now)).status, "same-date-conflict");
  assert.equal(comparePriceSources(base, fromTseWebgwHistory(identity, webgw(20261021, 679), now)).status, "base-newer");
});

test("different instruments, mismatched ISIN, malformed dates, no trades and out-of-range OHLC fail closed", () => {
  assert.equal(fromTsetmcCurrent(identity, tsetmc(20261024, 659, { insCode: "123" }), now), null);
  assert.equal(fromTsetmcCurrent(identity, tsetmc(20261024, 659, { qTotTran5J: 0 }), now), null);
  assert.equal(fromTsetmcCurrent(identity, tsetmc(20261024, 659, { priceMax: 650 }), now), null);
  assert.equal(fromTsetmcCurrent(identity, tsetmc(20260230, 659), now), null);
  assert.equal(fromTseWebgwHistory(identity, webgw(20261024, 659, { instrumentid: "IRO1FOLD0001" }), now), null);
  assert.equal(fromTseWebgwHistory({ ...identity, isin: null }, webgw(20261024, 659), now), null);
  const base = fromZarvanDaily(identity, [daily(20261024, 659)], now);
  assert.equal(comparePriceSources(base, null).status, "unavailable");
  assert.equal(comparePriceSources(base, { ...base, identity: { ...base.identity, insCode: "46348559193224090" } }).status, "different-instrument");
});

test("select most recent valid traded dated candle irrespective of provider row order", () => {
  const mixed = [daily(20261024, 659), daily(20261021, 679), daily(20261025, 1000)];
  assert.equal(fromZarvanDaily(identity, mixed, now).sessionDate, 20261024);
  assert.equal(fromTseWebgwHistory(identity, [...webgw(20261021, 679), ...webgw(20261024, 659)], now).sessionDate, 20261024);
});

test("WebGW source must echo exact instrument ID, and unknown state cannot silently become a valid daily close", () => {
  assert.equal(fromTseWebgwHistory(identity, webgw(20261024, 659, { instrumentid: undefined }), now), null);
  assert.equal(fromTseWebgwHistory(identity, webgw(20261024, 659, { instrumentid: undefined, InstrumentId: identity.isin }), now)?.closeRial, 659);
  assert.equal(fromTseWebgwHistory(identity, webgw(20261024, 659, {
    closingprice: { value: 659, state: 999 },
  }), now), null);
  assert.equal(fromTseWebgwHistory(identity, webgw(20261024, 659, {
    tradevolume: { value: 1000, state: "stale" },
  }), now), null);
});

test("before market close, today's date does not prove a finalized daily candle", () => {
  const beforeClose = new Date("2026-10-24T06:00:00Z");
  assert.equal(fromZarvanDaily(identity, [daily(20261024, 659)], beforeClose), null);
  assert.equal(fromZarvanDaily(identity, [daily(20261021, 679)], beforeClose)?.sessionDate, 20261021);
});

test("same-session close agreement cannot hide different OHLC or traded volume", () => {
  const base = fromZarvanDaily(identity, [daily(20261024, 659)], now);
  const differentlyAdjusted = fromTseWebgwHistory(identity, webgw(20261024, 659, {
    highvalue: { value: 670, state: "ok" },
  }), now);
  assert.equal(comparePriceSources(base, differentlyAdjusted).status, "same-date-close-match-ohlc-conflict");
});

test("Worker trims unused upstream daily fields without dropping recalculation-critical OHLC", async (t) => {
  const fixture = { ...daily(20261024, 659), volume: 1000, value: 659000, trade_count: 17 };
  const compact = compactScreenerCandle(fixture);
  assert.deepEqual(compact, {
    d_even: 20261024, high: 664, close: 659, low: 654, last: 659, open: 659, yesterday: 659,
  });
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/daily-batch?")) return Response.json({ "خودرو": [fixture] });
    if (String(url).includes("/instruments?")) return Response.json({ "خودرو": raw });
    throw Error("Base-only test may not fetch official hosts");
  });
  const result = await (await POST(new Request("https://localhost/api/screener", {
    method: "POST", body: JSON.stringify({ symbols: ["خودرو"], baseOnly: true }),
  }))).json();
  assert.equal(result.rows[0].priceQuote.sessionDate, 20261024);
  assert.equal(result.rows[0].priceQuote.closeRial, 659);
  assert.deepEqual(result.rows[0].analysisInput.candles[0], compact);
});

test("dated no-trade slots cannot shift screener last-trade session forward", async (t) => {
  const knownTrade = { ...daily(20261021, 679), volume: 1000 };
  const slotWithoutTrades = { ...daily(20261024, 659), volume: 0 };
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/daily-batch?")) return Response.json({ "خودرو": [slotWithoutTrades, knownTrade] });
    if (String(url).includes("/instruments?")) return Response.json({ "خودرو": raw });
    throw Error("Not a baseOnly endpoint");
  });
  const result = await (await POST(new Request("https://localhost/api/screener", {
    method: "POST", body: JSON.stringify({ symbols: ["خودرو"], baseOnly: true }),
  }))).json();
  assert.equal(result.rows[0].priceQuote.sessionDate, 20261021);
  assert.equal(result.rows[0].priceQuote.closeRial, 679);
  assert.equal(result.coverage.rejectedNoTrade, 1);
});

test("invalid high/low/close Zarvan rows are rejected instead of appearing as valid daily prices", async (t) => {
  const malformed = { ...daily(20261024, 659), high: 100, low: 700, volume: 1000 };
  assert.equal(validSourceDailyPrice(malformed, now), false);
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("/daily-batch?")) return Response.json({ "خودرو": [malformed] });
    if (String(url).includes("/instruments?")) return Response.json({ "خودرو": raw });
    throw Error("Base-only must not call official provider");
  });
  const result = await (await POST(new Request("https://localhost/api/screener", {
    method: "POST", body: JSON.stringify({ symbols: ["خودرو"], baseOnly: true }),
  }))).json();
  assert.equal(result.coverage.quoted, 0);
  assert.equal(result.rows[0].priceQuote ?? null, null);
});

test("screener final daily candle cannot be published before a trading session closes", () => {
  assert.equal(validSourceDailyPrice(daily(20261024, 659), new Date("2026-10-24T06:00:00Z")), false);
  assert.equal(validSourceDailyPrice(daily(20261021, 679), new Date("2026-10-24T06:00:00Z")), true);
  assert.equal(isClosedScreenerSession(20261024, new Date("2026-10-24T06:00:00Z")), false);
  assert.equal(isClosedScreenerSession(20261024, new Date("2026-10-24T11:00:00Z")), true);
});
test("highlight price observations reject pre-close dates, no trade, and impossible OHLC", () => {
  const preClose = new Date("2026-10-24T06:00:00Z");
  const closed = new Date("2026-10-24T11:00:00Z");
  const traded = {...daily(20261024, 659),last:659,open:659,yesterday:659,value:659000};
  const snapshot = {Date:20261024,PriceClose:659,PriceYesterday:659,PriceLast:659,PriceMin:654,PriceMax:664,Volume:1000};
  assert.equal(instrumentFromDailyRows([traded], 20261021, preClose),null);
  assert.equal(instrumentFromDailyRows([traded], 20261024, closed)?.Date,20261024);
  assert.equal(validHighlightSnapshotSession(snapshot,20261021,preClose),null);
  assert.equal(validHighlightSnapshotSession(snapshot,20261024,closed),20261024);
  assert.equal(validHighlightSnapshotSession({...snapshot,Volume:0},20261024,closed),null);
  assert.equal(validHighlightSnapshotSession({...snapshot,PriceMin:700},20261024,closed),null);
  assert.equal(instrumentFromDailyRows([{...traded,high:100}],20261024,closed),null);
  assert.equal(instrumentFromDailyRows([{...traded,volume:0}],20261024,closed),null);
});
