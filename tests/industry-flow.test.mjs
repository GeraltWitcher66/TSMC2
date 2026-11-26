import test from "node:test";
import assert from "node:assert/strict";
import {
  aggregateBuyPower, compactToman, shortIndustryName, sumIndustrySessions, withoutBuyPower,
} from "../app/lib/industry.ts";
import {
  aggregateIndustrySymbols, excludedInstrument, fundKind, outlierInstrument,
  parseClientTypeAll, parseMarketWatch,
} from "../app/lib/industry-symbols.ts";
import { backfillIndustryHistory } from "../app/lib/industry-history.ts";

const quote = (insCode, symbol, name, sectorCode, close, prevClose, value) => ({
  insCode, lva: symbol, lvc: name, csv: sectorCode,
  pClosing: close, pDrCotVal: close, py: prevClose, qTotCap: value, qTotTran5J: 1_000_000,
});
const flow = (insCode, buyVolume, sellVolume, buyValue, sellValue, buyCount, sellCount) => ({
  insCode, buy_I_Volume: buyVolume, sell_I_Volume: sellVolume,
  buy_I_Value: buyValue, sell_I_Value: sellValue, buy_CountI: buyCount, sell_CountI: sellCount,
});
const SECTORS = {
  "27": "فلزات اساسی",
  "44": "محصولات شیمیایی",
  "68": "صندوق سرمایه گذاری قابل معامله",
  "20": "جمع آوری، تصفیه و توزیع آب",
};

test("fund rows are split by fund type in the requested order", () => {
  assert.equal(fundKind("صندوق سرمایه گذاری اهرمی کاریزما"), "صندوق اهرمی");
  assert.equal(fundKind("صندوق سرمایه گذاری زعفران"), "صندوق زعفران");
  assert.equal(fundKind("صندوق طلا و کالا عیار"), "صندوق طلا و کالا");
  assert.equal(fundKind("صندوق بخشی صنعت روی"), "صندوق بخشی");
  assert.equal(fundKind("صندوق سرمایه گذاری درآمد ثابت اعتماد"), "صندوق درآمد ثابت");
  assert.equal(fundKind("اعتماد", "اعتماد-د"), "صندوق درآمد ثابت");
  assert.equal(fundKind("صندوق سرمایه گذاری سهامی"), "صندوق سهامی");
  assert.equal(fundKind("کارا", "کارا-س"), "صندوق سهامی");
  assert.equal(fundKind("صندوق سرمایه گذاری مختلط"), "صندوق مختلط و سایر");
  // Order matters: a leveraged fund whose name also mentions gold stays leveraged.
  assert.equal(fundKind("صندوق اهرمی طلا"), "صندوق اهرمی");
});

test("market watch and client type payloads are parsed into symbol rows", () => {
  const parsed = parseMarketWatch({
    marketwatch: [quote("1", "فولاد", "فولاد مبارکه اصفهان", "27 ", 5000, 4800, 1e12), { lva: "", insCode: "2" }],
  });
  assert.equal(parsed.length, 1, "a row without a symbol is dropped");
  assert.equal(parsed[0].sectorCode, "27", "sector codes are trimmed");
  assert.equal(parsed[0].close, 5000);
  assert.equal(parsed[0].value, 1e12);
  assert.ok(Math.abs(parsed[0].changePct - 4.1667) < 0.001);

  const flows = parseClientTypeAll({ clientTypeAllDto: [flow("1", 10, 5, 100, 50, 2, 4)] });
  assert.deepEqual(flows.get("1"), { buyVolume: 10, sellVolume: 5, buyValue: 100, sellValue: 50, buyCount: 2, sellCount: 4 });
  assert.equal(parseClientTypeAll({ nope: [] }).size, 0);
  // A repeated instrument must be counted once, or its value doubles.
  assert.equal(parseMarketWatch({ marketwatch: [quote("9", "فولاد", "فولاد", "27", 1, 1, 5), quote("9", "فولاد", "فولاد", "27", 1, 1, 5)] }).length, 1);
});

test("the live market-watch shape uses pcl/qtc/qtj while pClosing/qTotCap stay zero", () => {
  // Captured from GetMarketWatch: every equity row carries pClosing=0,
  // pDrCotVal=0 and qTotCap=0; the real closing price is `pcl`, traded value is
  // `qtc` and volume is `qtj`.
  const [row] = parseMarketWatch({ marketwatch: [{
    insCode: "28826731641795460", lva: "خوساز", lvc: "سیمان خوزستان", csv: "34 ",
    pClosing: 0, pDrCotVal: 0, pcl: 25740, pdv: 25700, py: 26380, pc: -780, pcpc: -640,
    qTotCap: 0, qtc: 230_865_000_000, qtj: 8_969_126,
  }] });
  assert.equal(row.close, 25740, "closing price comes from pcl");
  assert.equal(row.last, 25700, "last price comes from pdv");
  assert.equal(row.value, 230_865_000_000, "traded value comes from qtc");
  assert.equal(row.volume, 8_969_126);
  assert.equal(row.sectorCode, "34");
  assert.ok(Math.abs(row.changePct + 2.426) < 0.01, `change ${row.changePct}`);
});

test("industry totals come from per-symbol data, not the source buy_power", () => {
  const quotes = parseMarketWatch({
    marketwatch: [
      quote("A", "فولاد", "فولاد مبارکه اصفهان", "27", 5000, 4800, 1e12),
      quote("B", "کچاد", "چادرملو", "27", 3000, 2900, 5e11),
      quote("C", "شپنا", "پالایش نفت اصفهان", "44", 2000, 2100, 2e11),
      // An IPO-like symbol: +669% in one session must not enter the industry sum.
      quote("D", "آب", "شرکت آب", "20", 10, 1.3, 1e9),
    ],
  });
  const flows = parseClientTypeAll({
    clientTypeAllDto: [
      flow("A", 2_000_000, 1_000_000, 6e9, 2e9, 300, 200),
      flow("B", 100_000, 200_000, 3e9, 1e9, 3, 100),
      flow("C", 500_000, 400_000, 4e9, 3e9, 50, 50),
      flow("D", 1000, 1000, 1e8, 1e8, 10, 10),
    ],
  });
  const { rows, stats } = aggregateIndustrySymbols(quotes, flows, SECTORS);
  const names = rows.map((row) => row.name);
  assert.deepEqual(names, ["فلزات اساسی", "محصولات شیمیایی"]);
  assert.ok(!names.includes("جمع آوری، تصفیه و توزیع آب"), "the IPO-only industry is hidden");
  assert.equal(stats.extremeChange, 1);

  const metals = rows[0];
  // (2e6-1e6)*5000 + (1e5-2e5)*3000
  assert.equal(metals.net, 4.7e9);
  assert.equal(metals.value, 1.5e12);
  assert.equal(metals.symbols, 2);

  // Ratio of sums: (9e9/303) / (3e9/300). A mean of the two per-symbol ratios
  // would be thousands, which is exactly the source's broken buy_power.
  const expected = (9e9 / 303) / (3e9 / 300);
  assert.ok(Math.abs(metals.buyPower - expected) < 1e-9);
  const mean = ((6e9 / 300) / (2e9 / 200) + (3e9 / 3) / (1e9 / 100)) / 2;
  assert.ok(metals.buyPower < mean / 10, "the aggregate is not an average of ratios");
});

test("funds get one row per fund type and no lumped ETF row", () => {
  const quotes = parseMarketWatch({
    marketwatch: [
      quote("F1", "کارا", "صندوق سرمایه گذاری اهرمی کاریزما", "68", 20000, 19000, 4e9),
      quote("F2", "زعفران", "صندوق سرمایه گذاری زعفران", "68", 100000, 99000, 2e9),
      quote("F3", "اعتماد", "صندوق سرمایه گذاری درآمد ثابت اعتماد", "68", 10000, 10000, 9e9),
      quote("F4", "عیار", "صندوق طلا عیار", "68", 30000, 29500, 3e9),
    ],
  });
  const flows = parseClientTypeAll({
    clientTypeAllDto: [
      flow("F1", 10, 10, 1e9, 1e9, 10, 10),
      flow("F2", 10, 10, 1e9, 1e9, 10, 10),
      flow("F3", 10, 10, 1e9, 1e9, 10, 10),
      flow("F4", 10, 10, 1e9, 1e9, 10, 10),
    ],
  });
  const { rows } = aggregateIndustrySymbols(quotes, flows, SECTORS);
  assert.deepEqual(rows.map((row) => row.name).sort(), [
    "صندوق اهرمی", "صندوق درآمد ثابت", "صندوق زعفران", "صندوق طلا و کالا",
  ].sort());
  assert.ok(!rows.some((row) => row.name === "صندوق سرمایه گذاری قابل معامله"));
});

test("buy power uses real volume × average price when ClientTypeAll has no value fields", () => {
  // The live all-market feed only publishes volumes and person counts.
  const quotes = parseMarketWatch({
    marketwatch: [quote("A", "فولاد", "فولاد مبارکه اصفهان", "27", 5000, 4800, 1e12)],
  });
  const flows = parseClientTypeAll({ clientTypeAllDto: [{ insCode: "A", buy_I_Volume: 2e6, sell_I_Volume: 1e6, buy_CountI: 300, sell_CountI: 200 }] });
  const { rows } = aggregateIndustrySymbols(quotes, flows, SECTORS);
  // average price = 1e12 ÷ 1e6 = 1e6 rial per share
  // (2e6×1e6 / 300) ÷ (1e6×1e6 / 200)
  const expected = (2e12 / 300) / (1e12 / 200);
  assert.ok(Math.abs(rows[0].buyPower - expected) < 1e-9);
  assert.equal(rows[0].net, (2e6 - 1e6) * 5000);
});

test("rights, bonds and options never enter a total", () => {
  assert.equal(excludedInstrument(parseMarketWatch({ marketwatch: [quote("1", "فولادح", "حق تقدم فولاد", "27", 10, 9, 1e6)] })[0]), "rights-or-bond");
  assert.equal(excludedInstrument(parseMarketWatch({ marketwatch: [quote("2", "ضفولاد", "اختیار خرید فولاد", "27", 10, 9, 1e6)] })[0]), "option");
  assert.equal(outlierInstrument(parseMarketWatch({ marketwatch: [quote("3", "آب", "آب", "20", 10, 1.3, 1e6)] })[0]), "extreme-change");
  assert.equal(outlierInstrument(parseMarketWatch({ marketwatch: [quote("4", "نو", "نماد جدید", "20", 10, 0, 1e6)] })[0]), "first-session");
});

test("buy power is a ratio of sums and unknown when a side has no buyers", () => {
  assert.equal(aggregateBuyPower(900, 300, 300, 300), 3);
  assert.equal(aggregateBuyPower(900, 0, 300, 300), null);
  assert.equal(aggregateBuyPower(null, 10, 300, 300), null);
  assert.equal(aggregateBuyPower(900, 10, 0, 10), null);
});

test("fallback rows show no buy power instead of the source mean", () => {
  const rows = withoutBuyPower([{ code: "27", name: "فلزات", net: 1, value: 2, buyPower: 11.16, symbols: 56,
    realBuyValue: 5, realSellValue: 3, buyCount: 2, sellCount: 2 }]);
  assert.equal(rows[0].buyPower, null);
  assert.equal(rows[0].net, 1, "published inflow and value are kept");
  assert.equal(rows[0].value, 2);
});

test("multi-session buy power is rebuilt from summed components", () => {
  const row = (name, net, parts) => ({ code: name, name, net, value: 100, buyPower: null, symbols: 1,
    realBuyValue: null, realSellValue: null, buyCount: null, sellCount: null, ...parts });
  const day1 = { date: 20261124, rows: [row("فلزات", 1, { realBuyValue: 500, buyCount: 10, realSellValue: 200, sellCount: 10 })] };
  const day2 = { date: 20261125, rows: [row("فلزات", 2, { realBuyValue: 500, buyCount: 20, realSellValue: 300, sellCount: 30 })] };
  const summed = sumIndustrySessions([day1, day2], 3);
  assert.equal(summed[0].net, 3);
  // (1000/30) / (500/40)
  assert.ok(Math.abs(summed[0].buyPower - (1000 / 30) / (500 / 40)) < 1e-9);
  assert.equal(sumIndustrySessions([{ date: 20261125, rows: [row("نفت", 5, {})] }], 3)[0].buyPower, null);
});

test("amounts are compact Toman with T/B/M and short industry names", () => {
  assert.equal(compactToman(8_865_316_913_331), "۸۸۶.۵B");
  assert.equal(compactToman(47_400_000_000_000), "۴.۷T");
  assert.equal(compactToman(-1_050_000_000_000), "-۱۰۵B");
  assert.equal(compactToman(null), "—");
  assert.equal(shortIndustryName("فلزات اساسی"), "فلزات");
  assert.equal(shortIndustryName("عرضه برق، گاز، بخاروآب گرم"), "عرضه برق");
  assert.equal(shortIndustryName("بانکها و موسسات اعتباری"), "بانک");
  assert.equal(shortIndustryName("گروه ناشناخته"), "گروه ناشناخته");
});

test("history backfill rebuilds earlier sessions with at most six requests in flight", async () => {
  const symbols = [
    { insCode: "A", symbol: "فولاد", name: "فولاد مبارکه اصفهان", sectorCode: "27" },
    { insCode: "B", symbol: "کچاد", name: "چادرملو", sectorCode: "27" },
  ];
  let inFlight = 0;
  let peak = 0;
  const requested = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    if (target.startsWith("https://cdn.tsetmc.com")) throw new Error("blocked");
    const path = decodeURIComponent(target.split("path=")[1] ?? "");
    requested.push(path);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 1));
    inFlight -= 1;
    if (path.startsWith("ClosingPrice/GetClosingPriceDailyList/")) {
      return { ok: true, json: async () => ({ closingPriceDaily: [
        { dEven: 20261126, pClosing: 5000, priceYesterday: 4800, qTotCap: 1e12 },
        { dEven: 20261125, pClosing: 4800, priceYesterday: 4700, qTotCap: 9e11 },
        { dEven: 20261124, pClosing: 4700, priceYesterday: 4600, qTotCap: 8e11 },
      ] }) };
    }
    return { ok: true, json: async () => ({ clientType: {
      insCode: "A", recDate: 20261125,
      buy_I_Volume: 2e6, sell_I_Volume: 1e6, buy_I_Value: 9e9, sell_I_Value: 3e9,
      buy_CountI: 300, sell_CountI: 200,
    } }) };
  };
  const progress = [];
  const sessions = await backfillIndustryHistory(symbols, SECTORS, {
    needed: 2, excludeDates: [20261126], fetchImpl,
    onProgress: (update) => progress.push(update),
  });
  assert.deepEqual(sessions.map((session) => session.date), [20261125, 20261124]);
  assert.ok(peak <= 6, `concurrency stayed bounded (peak ${peak})`);
  assert.ok(requested.filter((path) => path.startsWith("ClientType/GetClientTypeHistory/")).length === 4);
  assert.ok(progress.some((update) => update.phase === "prices"));
  assert.ok(progress.some((update) => update.phase === "flows"));
  const metals = sessions[0].rows[0];
  assert.equal(metals.name, "فلزات اساسی");
  assert.equal(metals.value, 1.8e12);
  assert.ok(metals.buyPower !== null);
});
