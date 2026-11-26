import test from "node:test";
import assert from "node:assert/strict";
import { GET as sectorMap } from "../app/api/sector-map/route.ts";
import { parseIndustries, sumIndustrySessions, upsertIndustrySnapshot } from "../app/lib/industry.ts";

test("industry aggregates keep the source's whole-market totals and rank by net inflow", () => {
  const rows = parseIndustries([
    { sector_code: " 27 ", sector_name: " فلزات اساسی ", net_real: 8865316913331, value: 52294875739140, buy_power: 11.16, symbols: 56 },
    { sector_code: "68", sector_name: "صندوق سرمایه گذاری قابل معامله", net_real: -1, value: 821157333612518, buy_power: null, symbols: "345" },
    { sector_code: "44", sector_name: "محصولات شیمیایی", net_real: 5740541609631, value: 52649705667620, buy_power: 7.9, symbols: 68 },
    { sector_code: "", sector_name: "", net_real: 5, value: 5 },
  ]);
  assert.deepEqual(rows.map((row) => row.name), ["فلزات اساسی", "محصولات شیمیایی", "صندوق سرمایه گذاری قابل معامله"]);
  assert.equal(rows[0].code, "27", "sector codes are trimmed");
  assert.equal(rows[0].net, 8865316913331, "money inflow is never recomputed from watchlist symbols");
  assert.equal(rows[0].value, 52294875739140);
  assert.equal(rows[0].symbols, 56);
  assert.equal(rows[2].buyPower, null);
  assert.equal(rows[2].symbols, 345, "numeric strings are accepted");
  assert.throws(() => parseIndustries({ not: "an array" }), /ساختار/);
  assert.throws(() => parseIndustries([{ sector_name: "" }]), /نام صنایع/);
});

test("three-day industry totals add money and value but keep the newest buy power", () => {
  const row = (name, net, value, buyPower, symbols = 1) => ({ code: name, name, net, value, buyPower, symbols });
  const day1 = { date: 20261123, rows: [row("فلزات", 100, 1000, 9), row("بانک", -50, 400, 0.5)] };
  const day2 = { date: 20261124, rows: [row("فلزات", 200, 2000, 4)] };
  const day3 = { date: 20261125, rows: [row("فلزات", 300, 3000, 2.1, 56), row("بانک", 25, 100, 1.2)] };
  const summed = sumIndustrySessions([day3, day1, day2], 3);
  assert.deepEqual(summed.map((item) => item.name), ["فلزات", "بانک"]);
  assert.equal(summed[0].net, 600, "money inflow is the sum of the recorded sessions");
  assert.equal(summed[0].value, 6000);
  assert.equal(summed[0].buyPower, 2.1, "a ratio is never added across days");
  assert.equal(summed[0].symbols, 56, "symbol count comes from the newest session");
  assert.equal(summed[1].net, -25);
  assert.equal(summed[1].value, 500);
  // Only the requested window is summed.
  assert.equal(sumIndustrySessions([day1, day2, day3], 1)[0].net, 300);
  assert.deepEqual(sumIndustrySessions([], 3), []);
  // A missing value stays missing instead of becoming zero.
  const gap = sumIndustrySessions([{ date: 20261125, rows: [row("نفتی", null, null, null)] }], 3);
  assert.equal(gap[0].net, null);
  assert.equal(gap[0].value, null);
});

test("snapshots keep one row per session date and cap their history", () => {
  const rows = [{ code: "27", name: "فلزات", net: 1, value: 2, buyPower: 3, symbols: 4 }];
  const first = upsertIndustrySnapshot([], 20261125, rows);
  const replaced = upsertIndustrySnapshot(first, 20261125, [{ ...rows[0], net: 9 }]);
  assert.equal(replaced.length, 1, "the same session is replaced, not duplicated");
  assert.equal(replaced[0].rows[0].net, 9);
  assert.equal(upsertIndustrySnapshot(first, null, rows).length, 1, "an unknown date records nothing");
  let many = [];
  for (let day = 1; day <= 14; day++) many = upsertIndustrySnapshot(many, 20261000 + day, rows, 10);
  assert.equal(many.length, 10);
  assert.equal(many.at(-1).date, 20261014);
});

test("route reports a clear failure when the industry list is unavailable", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 503 }));
  const response = await sectorMap();
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /صنعت/);
});

test("route serves the source aggregates once and reuses them", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => {
    calls += 1;
    return Response.json([
      { sector_code: "27", sector_name: "فلزات اساسی", net_real: 100, value: 500, buy_power: 2.1, symbols: 56 },
    ]);
  });
  const first = await (await sectorMap()).json();
  assert.equal(first.industries[0].net, 100);
  assert.equal(first.stale, false);
  const second = await (await sectorMap()).json();
  assert.equal(calls, 1, "the aggregate sweep is cached");
  assert.deepEqual(second.industries, first.industries);
});
