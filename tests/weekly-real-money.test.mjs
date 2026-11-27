import test from "node:test";
import assert from "node:assert/strict";
import {
  loadWeeklyInflow, parseTradedSessions, pruneWeeklyCache, rankWeeklyInflow, weeklyCoverageLabel, weeklySummary,
} from "../app/lib/weekly-real-money.ts";

const highlight = (symbol, insCode, sessionDate, net, close = 1000) => ({
  symbol, insCode, name: symbol, sessionDate,
  clientTypeDate: sessionDate, clientTypeAvailable: true,
  realBuyValue: net >= 0 ? net : 0, realSellValue: net >= 0 ? 0 : -net,
  realBuyVolume: 0, realSellVolume: 0, priceClose: close, priceLast: close,
});

test("the five-session total adds session nets and labels an incomplete window", () => {
  const full = weeklySummary([10, -3, 2, 0, 1]);
  assert.equal(full.net, 10);
  assert.equal(full.covered, 5);
  assert.equal(full.coverageLabel, null, "a complete window has no partial label");

  // Three usable sessions out of five: the sum is kept and the card says so.
  const partial = weeklySummary([10, -3, 2]);
  assert.equal(partial.net, 9);
  assert.equal(partial.covered, 3);
  assert.equal(partial.coverageLabel, "۳ از ۵ جلسه");
  assert.equal(weeklyCoverageLabel(5), null);
  assert.equal(weeklyCoverageLabel(1), "۱ از ۵ جلسه");
  // A symbol with no usable session is not a zero-inflow row.
  assert.equal(weeklySummary([null, null]).net, null);
});

test("only traded sessions of the daily list count, newest first", () => {
  const sessions = parseTradedSessions({
    closingPriceDaily: [
      { dEven: 20261126, pClosing: 1200, qTotTran5J: 0 },       // halted, no trade
      { dEven: 20261125, pcl: 1100, qtj: 5000 },
      { dEven: 20261124, pClosing: 1000, qTotTran5J: 7000 },
    ],
  });
  assert.deepEqual(sessions.map((session) => session.date), [20261125, 20261124]);
  assert.equal(sessions[0].close, 1100);
});

test("the weekly card ranks by inflow and keeps ten positive rows", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({
    symbol: `S${index}`, insCode: `${index}`, net: index - 5, covered: 5, coverageLabel: null, dates: [20261125],
  }));
  const ranked = rankWeeklyInflow(rows, 10);
  assert.equal(ranked.length, 6, "non-positive inflows stay out");
  assert.deepEqual(ranked.map((row) => row.net), [6, 5, 4, 3, 2, 1]);
  assert.ok(!ranked.some((row) => row.net <= 0));
});

test("the browser cache keeps the newest ten sessions only", () => {
  const cache = {};
  for (let day = 1; day <= 14; day += 1) cache[`100:202611${String(day).padStart(2, "0")}`] = { net: day };
  const pruned = pruneWeeklyCache(cache, 10);
  const kept = [...new Set(Object.keys(pruned).map((key) => Number(key.split(":")[1])))].sort();
  assert.equal(kept.length, 10);
  assert.equal(kept[0], 20261105);
  assert.equal(kept[9], 20261114);
});

test("the last session comes from the daily card and older sessions are fetched once", async () => {
  const symbols = [
    highlight("فولاد", "A", 20261126, 50),
    highlight("کچاد", "B", 20261126, 70),
  ];
  const daily = (dates, close = 1000) => ({ closingPriceDaily: dates.map((date) => ({ dEven: date, pClosing: close, qTotTran5J: 1000 })) });
  const requested = [];
  const clientType = (code, date) => ({ clientType: {
    insCode: code, recDate: date,
    buy_I_Value: code === "A" ? 120 : 140, sell_I_Value: 100, buy_I_Volume: 3, sell_I_Volume: 1,
    buy_N_Volume: 2, sell_N_Volume: 2, buy_I_Count: 2, sell_I_Count: 2,
  } });
  const fetchImpl = async (url) => {
    const target = String(url);
    requested.push(target);
    const json = (value) => ({ ok: true, json: async () => value });
    if (target.includes("GetClosingPriceDailyList/A")) return json(daily([20261126, 20261125, 20261124, 20261123, 20261122]));
    if (target.includes("GetClosingPriceDailyList/B")) return json(daily([20261126, 20261125, 20261124]));
    const match = /GetClientTypeHistory\/(\w+)\/(\d{8})/.exec(target);
    if (match) return json(clientType(match[1], Number(match[2])));
    throw new Error(`unexpected ${target}`);
  };
  const rows = await loadWeeklyInflow({ rows: symbols, fetchImpl });

  const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
  // Latest session uses the card's own 50; each older session adds 120−100 = 20.
  assert.equal(bySymbol.get("فولاد").net, 130);
  assert.equal(bySymbol.get("فولاد").covered, 5);
  assert.equal(bySymbol.get("فولاد").coverageLabel, null);
  // 70 from the card plus two older sessions of 140−100 = 40 each.
  assert.equal(bySymbol.get("کچاد").net, 150);
  assert.equal(bySymbol.get("کچاد").covered, 3);
  assert.equal(bySymbol.get("کچاد").coverageLabel, "۳ از ۵ جلسه");
  assert.deepEqual(bySymbol.get("کچاد").dates, [20261126, 20261125, 20261124]);

  // A five-session symbol asks for four older ClientType records, never the card's session.
  const clientTypeCalls = requested.filter((url) => url.includes("GetClientTypeHistory"));
  assert.equal(clientTypeCalls.length, 4 + 2);
  assert.ok(!clientTypeCalls.some((url) => url.endsWith("/20261126")));
});
