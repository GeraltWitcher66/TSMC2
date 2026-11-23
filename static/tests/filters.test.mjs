import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePeriod,
  calculateRsi,
  calculateValuationMetrics,
  detectGapActions,
  parseSymbolList,
  symbolsForScope,
} from "../../app/lib/market.ts";
import { dispatchApiPath } from "../src/api/router.ts";

const candles = [
  { d_even: 20260811, close: 4500, high: 4600, yesterday: 4400 },
  { d_even: 20260720, close: 4800, high: 5000, yesterday: 4700 },
  { d_even: 20260513, close: 3000, high: 3200, yesterday: 2950 },
  { d_even: 20260211, close: 2000, high: 2100, yesterday: 1980 },
];

const signal = () => new AbortController().signal;

test("the extracted period engine keeps the 90-day return and drawdown contract", () => {
  const metrics = calculatePeriod(candles, 90);
  assert.ok(metrics);
  assert.equal(metrics.startPrice, 3000);
  assert.equal(metrics.peakPrice, 5000);
  assert.equal(metrics.currentPrice, 4500);
  assert.equal(metrics.returnPct, 50);
  assert.equal(metrics.drawdownPct, 10);
  assert.equal(metrics.startDate, "20260513");
});

test("the extracted period engine adjusts history only with an official share change", () => {
  const metrics = calculatePeriod(candles, 180, [{ date: 20260701, oldShares: 100, newShares: 200 }]);
  assert.ok(metrics);
  assert.equal(metrics.startPrice, 1500);
  assert.equal(metrics.returnPct, 200);
});

test("the extracted RSI keeps Wilder's seed and the flat-history case", () => {
  const rising = Array.from({ length: 20 }, (_, index) => ({
    d_even: 20260101 + index,
    close: 100 + index,
    high: 100 + index,
  })).reverse();
  assert.equal(calculateRsi(rising), 100);
  assert.equal(calculateRsi(rising.map((item) => ({ ...item, close: 100, high: 100 }))), 50);
});

test("the extracted valuation formulas still match the customer examples", () => {
  const positive = calculateValuationMetrics(37_910, 3_879, 9.77, 17.44);
  assert.equal(positive.epsSectorPePrice, 67_650);
  assert.equal(positive.epsSectorPeUpsidePct, 78.45);
  assert.equal(positive.epsSectorPePositive, true);
  assert.equal(positive.peBelowSector, true);

  const unavailable = calculateValuationMetrics(709, -49, -14.6, -23.75);
  assert.equal(unavailable.epsSectorPePrice, null);
  assert.equal(unavailable.peBelowSector, false);
});

test("the extracted symbol parser ignores ranks, prices and table headers", () => {
  const parsed = parseSymbolList([
    "رتبه\tنماد\tقیمت پایانی\tدرصد",
    "1\tکفپارس\t۵۰۰\t+۲٫۴٪",
    "۲. هم ارز ۱٬۲۹۰ −۳٪",
    "نماد: کحافظ 870 1.2%",
  ].join("\n"));
  assert.deepEqual(parsed, ["کفپارس", "هم ارز", "کحافظ"]);
});

test("watchlist scopes stay independent and the union removes duplicates", () => {
  const lists = { haghighi: ["كسرام", "کفپارس"], zarbanana: ["کسرام", "سپیدار"], custom: ["هم ارز"] };
  assert.deepEqual(symbolsForScope(lists, "haghighi"), ["کسرام", "کفپارس"]);
  assert.deepEqual(symbolsForScope(lists, "all"), ["کسرام", "کفپارس", "سپیدار", "هم ارز"]);
});

test("an unconfirmed price gap is never reported as a capital increase", () => {
  const actions = detectGapActions([
    { d_even: 20260702, close: 3100, high: 3200, yesterday: 3000 },
    { d_even: 20260630, close: 6000, high: 6100, yesterday: 5900 },
  ], [], 20260101);
  assert.equal(actions[0].confirmed, false);
  assert.equal(actions[0].kind, "شکاف تعدیل نیازمند بررسی");
});

test("browser handlers answer without any network endpoint", async () => {
  const emptySymbols = await dispatchApiPath("screener", {
    method: "POST",
    body: JSON.stringify({ symbols: [] }),
  }, signal());
  assert.equal(emptySymbols.status, 400);
  assert.match((await emptySymbols.json()).error, /حداقل یک نماد/);

  const tooMany = await dispatchApiPath("market-highlights", {
    method: "POST",
    body: JSON.stringify({ symbols: Array.from({ length: 11 }, (_, index) => `نماد${index}`) }),
  }, signal());
  assert.equal(tooMany.status, 400);

  const emptyHolderList = await dispatchApiPath("holders", {
    method: "POST",
    body: JSON.stringify({ symbols: [] }),
  }, signal());
  assert.equal(emptyHolderList.status, 200);
  assert.deepEqual((await emptyHolderList.json()).counts, {});

  const badCursor = await dispatchApiPath("holder-increases?cursor=-1", {}, signal());
  assert.equal(badCursor.status, 400);

  const unknown = await dispatchApiPath("unknown-route", {}, signal());
  assert.equal(unknown.status, 404);
});
