import assert from "node:assert/strict";
import test from "node:test";
import divergenceSnapshots from "./fixtures/divergence-real-snapshots.json" with { type: "json" };
import positiveDivergenceSnapshot from "./fixtures/divergence-positive-real-snapshot.json" with { type: "json" };
import customerDivergenceScreenshots from "./fixtures/customer-divergence-screenshots.json" with { type: "json" };
import { loadVerifiedHolderSnapshot } from "../app/data/holder-snapshot.ts";
import {
  analyzeDivergence,
  applyClientTypeToHighlight,
  calculatePeriod,
  candleFromInstrument,
  candleFromUndatedInstrument,
  calculateRsi,
  calculateValuationMetrics,
  detectDivergence,
  detectGapActions,
  extractMajorIndividualHoldingChanges,
  extractMajorIndividualHoldingIncreases,
  isSellQueueToPositive,
  isClosedTehranDailyCandle,
  marketHighlightFromInstrument,
  closingPriceGap,
  normalizeSymbol,
  latestMarketDate,
  mergeCandlesByDate,
  parseTsetmcDailyHistory,
  parseTsetmcTradeHistory,
  parseSymbolList,
  summarizeMajorIndividualHoldingChanges,
  subtractCalendarDays,
  symbolsForScope,
} from "../app/lib/market.ts";

test("decodes the dated verified shareholder fallback without losing rows or summaries", async () => {
  const snapshot = await loadVerifiedHolderSnapshot();
  assert.equal(snapshot.sourceDate, 20260907);
  assert.equal(snapshot.rows.length, 77);
  assert.equal(Object.keys(snapshot.summaries).length, 178);
  assert.equal(snapshot.rows[0].symbol, "وتجارت");
  assert.equal(snapshot.rows[0].changeShares, 1_270_000_000);
});

test("keeps only confirmed positive snapshot increases by major individual holders", () => {
  const result = extractMajorIndividualHoldingIncreases({
    dates: [20260826, 20260829, 20260831, 20260901, 20260902],
    shareHoldersChanges: [
      {
        name: "شخص حقيقي",
        insList: [
          { insCode: "A", name: "نماد مثبت", firstDay: 70, secondDay: 80, thirdDay: 90, fourthDay: 100, fifthDay: 150 },
          { insCode: "B", name: "نماد ثابت", firstDay: 200, secondDay: 200, thirdDay: 200, fourthDay: 200, fifthDay: 200 },
          { insCode: "C", name: "نماد کاهش", firstDay: 350, secondDay: 330, thirdDay: 320, fourthDay: 300, fifthDay: 250 },
          { insCode: "D", name: "ورود تازه", firstDay: 0, secondDay: 0, thirdDay: 0, fourthDay: 0, fifthDay: 50 },
          { insCode: "E", name: "مثبت دوم", firstDay: 400, secondDay: 420, thirdDay: 450, fourthDay: 500, fifthDay: 510 },
          { insCode: "G", name: "ورود تازه رسمی", firstDay: 0, secondDay: 0, thirdDay: 0, fifthDay: 25, officialChangeShares: 25 },
        ],
      },
      {
        name: "شرکت سرمایه گذاری نمونه",
        insList: [
          { insCode: "F", name: "نماد حقوقی", firstDay: 100, secondDay: 110, thirdDay: 120, fourthDay: 130, fifthDay: 200 },
        ],
      },
    ],
  });

  assert.deepEqual(result.map((item) => item.insCode), ["A", "G", "E"]);
  assert.equal(result[0].changeShares, 50);
  assert.equal(result[0].previousShares, 100);
  assert.equal(result[0].currentShares, 150);
  assert.equal(result[0].changeEvidence, "snapshot");
  assert.equal(result[0].date, 20260902);
  assert.equal(result[0].shareholderType, "شخص حقیقی");
  assert.equal(result[1].previousShares, null);
  assert.equal(result[1].changeShares, 25);
  assert.equal(result[1].changeEvidence, "official");
  assert.equal(result.some((item) => item.insCode === "D"), false);
  assert.equal(result.some((item) => item.insCode === "B" || item.insCode === "C" || item.insCode === "F"), false);
});

test("counts signed major-individual buyers and sellers per symbol", () => {
  const changes = extractMajorIndividualHoldingChanges({
    dates: [20260831, 20260901, 20260902],
    shareHoldersChanges: [
      { id: "buyer-1", name: "شخص حقیقی", insList: [{ insCode: "A", name: "الف", firstDay: 80, secondDay: 100, thirdDay: 150 }] },
      { id: "buyer-2", name: "شخص حقیقی", insList: [{ insCode: "A", name: "الف", firstDay: 180, secondDay: 200, thirdDay: 225 }] },
      { id: "seller-1", name: "شخص حقیقی", insList: [{ insCode: "A", name: "الف", firstDay: 400, secondDay: 350, thirdDay: 300 }] },
      { id: "seller-2", name: "شخص حقیقی", insList: [{ insCode: "B", name: "ب", firstDay: 100, secondDay: 90, thirdDay: 0 }] },
      { id: "unchanged", name: "شخص حقیقی", insList: [{ insCode: "C", name: "پ", firstDay: 100, secondDay: 100, thirdDay: 100 }] },
      { id: "company", name: "شرکت نمونه", insList: [{ insCode: "A", name: "الف", firstDay: 1, secondDay: 2, thirdDay: 3 }] },
    ],
  });
  const summaries = summarizeMajorIndividualHoldingChanges(changes);

  assert.equal(changes.length, 4);
  assert.deepEqual(summaries.A, { buyCount: 2, sellCount: 1, buyShares: 75, sellShares: 50 });
  assert.deepEqual(summaries.B, { buyCount: 0, sellCount: 1, buyShares: 0, sellShares: 90 });
  assert.equal(summaries.C, undefined);
});

test("ignores TSETMC's pre-created future session slot for holder changes", () => {
  const changes = extractMajorIndividualHoldingChanges({
    dates: [20260829, 20260831, 20260901, 20260902, 20260905],
    shareHoldersChanges: [{
      id: "buyer",
      name: "شخص حقیقی",
      insList: [{ insCode: "A", name: "الف", firstDay: 70, secondDay: 80, thirdDay: 90, fourthDay: 120, fifthDay: 0 }],
    }],
  }, { now: new Date("2026-09-03T08:00:00.000Z") });

  assert.equal(changes.length, 1);
  assert.equal(changes[0].date, 20260902);
  assert.equal(changes[0].previousShares, 90);
  assert.equal(changes[0].currentShares, 120);
  assert.equal(changes[0].changeShares, 30);
});

test("matches the customer EPS and sector P/E formulas", () => {
  const positive = calculateValuationMetrics(37_910, 3_879, 9.77, 17.44);
  assert.equal(positive.epsSectorPePrice, 67_650);
  assert.equal(positive.epsSectorPePositive, true);
  assert.equal(positive.peBelowSector, true);
  assert.equal(positive.epsSectorPeUpsidePct, 78.45);

  const negative = calculateValuationMetrics(4_416, 201, 21.97, 13.68);
  assert.equal(negative.epsSectorPePrice, 2_750);
  assert.equal(negative.epsSectorPePositive, false);
  assert.equal(negative.peBelowSector, false);

  const unavailable = calculateValuationMetrics(709, -49, -14.6, -23.75);
  assert.equal(unavailable.epsSectorPePrice, null);
  assert.equal(unavailable.epsSectorPePositive, false);
  assert.equal(unavailable.peBelowSector, false);
});

test("compares the visible stock P/E with group P/E without replacing them by a quotient", () => {
  const positive = calculateValuationMetrics(1000, 100, 9.77, 17.44);
  assert.equal(positive.pe, 9.77);
  assert.equal(positive.sectorPe, 17.44);
  assert.equal(positive.peBelowSector, true);

  assert.equal(calculateValuationMetrics(1000, 100, 18, 17.44).peBelowSector, false);
  assert.equal(calculateValuationMetrics(1000, 100, 0, 17.44).peBelowSector, false);
  assert.equal(calculateValuationMetrics(1000, 100, -2, 17.44).peBelowSector, false);
  assert.equal(calculateValuationMetrics(1000, 100, Number.NaN, 17.44).peBelowSector, false);
  assert.equal(calculateValuationMetrics(1000, 100, 9.77, Number.NaN).peBelowSector, false);
});

test("rejects invalid EPS/group P/E values and verifies real valuation examples", () => {
  const invalid = calculateValuationMetrics(1000, Number.POSITIVE_INFINITY, 5, 10);
  assert.equal(invalid.epsSectorPePrice, null);
  assert.equal(invalid.epsSectorPeUpsidePct, null);
  assert.equal(invalid.epsSectorPePositive, false);

  const realExamples = [
    { symbol: "کفپارس", close: 5200, eps: 722, pe: 7.2, sectorPe: 11.39, price: 8220, upside: 58.08, pePositive: true },
    { symbol: "افق", close: 68180, eps: 5195, pe: 13.1, sectorPe: 13.19, price: 68520, upside: 0.5, pePositive: true },
    { symbol: "فولای", close: 4270, eps: 393, pe: 10.9, sectorPe: 6.36, price: 2500, upside: -41.45, pePositive: false },
  ];
  for (const example of realExamples) {
    const result = calculateValuationMetrics(example.close, example.eps, example.pe, example.sectorPe);
    assert.equal(result.epsSectorPePrice, example.price, example.symbol);
    assert.equal(result.epsSectorPeUpsidePct, example.upside, example.symbol);
    assert.equal(result.peBelowSector, example.pePositive, example.symbol);
  }
});

// These snapshots recorded real market data for symbols the client disputed
// under the OLD pivot engine. Under the NEW day-over-day specification they
// assert only the current contract: the classification is the latest-two-
// closed-sessions close/RSI comparison, serialized losslessly.
test("short real histories classify deterministically under the daily rule", () => {
  for (const sample of divergenceSnapshots.cases) {
    assert.equal(sample.candles.length, 70);
    const result = analyzeDivergence(sample.candles, [], 90, { now: new Date(divergenceSnapshots.capturedAt) });
    assert.ok(["positive", "negative", "none", "insufficient", "stale", "adjustment", "invalid"].includes(result.status), result.status);
    // detectDivergence facade matches analysis.divergence exactly.
    assert.deepEqual(detectDivergence(sample.candles, [], 90, { now: new Date(divergenceSnapshots.capturedAt) }), result.divergence);
  }
});
test("real market snapshots survive JSON round trip under the daily rule", () => {
  const samples = [positiveDivergenceSnapshot, ...customerDivergenceScreenshots.cases.map((c, i) => ({ candles: c.candles, changes: c.changes, capturedAt: customerDivergenceScreenshots.capturedAt }))];
  for (const sample of samples) {
    const result = analyzeDivergence(sample.candles, sample.changes ?? [], 90, { now: new Date(sample.capturedAt) });
    const restored = JSON.parse(JSON.stringify(result));
    assert.deepEqual(restored, result);
  }
});

test("only treats the current Tehran daily candle as closed after the session boundary", () => {
  assert.equal(isClosedTehranDailyCandle(20260831, new Date("2026-08-31T08:45:00.000Z")), false);
  assert.equal(isClosedTehranDailyCandle(20260831, new Date("2026-08-31T09:31:00.000Z")), true);
  assert.equal(isClosedTehranDailyCandle(20260830, new Date("2026-08-31T08:45:00.000Z")), true);
  assert.equal(isClosedTehranDailyCandle(20260901, new Date("2026-08-31T09:31:00.000Z")), false);
});

test("builds list-only market highlights and detects negative-to-positive reversal", () => {
  const row = marketHighlightFromInstrument({
    InsCode: "123", Symbol: "خودرو", Name: "ایران خودرو", PriceYesterday: 1000, PriceFirst: 980,
    PriceMin: 950, PriceLast: 1030, PriceClose: 1010, AllowedMin: 950,
    Volume: 12_000_000, Value: 12_400_000_000, NetRealValue: 3_200_000_000,
  }, {
    buy_I_Volume: 3_000_000, sell_I_Volume: 2_000_000,
    buy_N_Volume: 1_000_000, sell_N_Volume: 2_000_000,
    buy_CountI: 30, sell_CountI: 40, buy_CountN: 2, sell_CountN: 4,
  });
  assert.ok(row);
  assert.equal(row.insCode, "123");
  assert.equal(row.symbol, "خودرو");
  assert.equal(row.minChangePct, -5);
  assert.equal(row.lastChangePct, 3);
  assert.equal(row.closeChangePct, 1);
  assert.equal(row.lastCloseGapPct, 1.98);
  assert.equal(row.reversalPct, 8.42);
  assert.equal(row.touchedSellQueue, true);
  assert.equal(row.realBuyVolume, 3_000_000);
  assert.equal(row.realSellVolume, 2_000_000);
  assert.equal(row.buyPower, 2);
  assert.equal(row.clientTypeAvailable, true);
  assert.equal(isSellQueueToPositive(row), false, "positive closing price must exclude the row");
});

test("enriches a Zarvan highlight with browser-fetched TSETMC client types", () => {
  const base = marketHighlightFromInstrument({
    InsCode: "123", Symbol: "خودرو", PriceYesterday: 1000, PriceMin: 950,
    PriceLast: 1030, PriceClose: 980, AllowedMin: 950, BuyPower: 0,
  });
  assert.ok(base);
  const enriched = applyClientTypeToHighlight(base, {
    buy_I_Volume: 3_000_000, sell_I_Volume: 2_000_000,
    buy_N_Volume: 1_000_000, sell_N_Volume: 2_000_000,
    buy_CountI: 30, sell_CountI: 40, buy_CountN: 2, sell_CountN: 4,
  });
  assert.equal(enriched.realBuyVolume, 3_000_000);
  assert.equal(enriched.realSellVolume, 2_000_000);
  assert.equal(enriched.buyPower, 2);
  assert.equal(enriched.clientTypeAvailable, true);
});

test("uses today's closing price as the denominator for the last-minus-close gap", () => {
  const row = marketHighlightFromInstrument({ Symbol: "کیا", PriceYesterday: 10000, PriceLast: 10268, PriceClose: 9708 });
  assert.equal(row.lastChangePct, 2.68);
  assert.equal(row.closeChangePct, -2.92);
  assert.deepEqual(closingPriceGap(10268, 9708), { rial: 560, percent: 5.77 });
  assert.equal(row.lastCloseGapPct, 5.77);
  assert.deepEqual(closingPriceGap(950, 1000), { rial: -50, percent: -5 });
  assert.deepEqual(closingPriceGap(1000, 1000), { rial: 0, percent: 0 });
  assert.equal(closingPriceGap(1000, 0), null);
});

test("counts the two Kseram screenshot purchases independently of their sizes", () => {
  // Numeric regression based on the image; the image's historical date is unknown.
  const changes = extractMajorIndividualHoldingChanges({ dates: [20260906, 20260907], shareHoldersChanges: [
    { id: "holder-one", name: "شخص حقیقی", insList: [{ insCode: "K", firstDay: 18000000 - 846297, secondDay: 18000000 }] },
    { id: "holder-two", name: "شخص حقیقی", insList: [{ insCode: "K", firstDay: 12000000, secondDay: 13000000 }] },
  ] });
  assert.deepEqual(changes.map((row) => row.changeShares).sort((a, b) => a - b), [846297, 1000000]);
  assert.equal(summarizeMajorIndividualHoldingChanges(changes).K.buyCount, 2);
});

test("requires sell-queue floor, positive last and negative closing for the reversal filter", () => {
  const build = (overrides = {}) => marketHighlightFromInstrument({
    InsCode: "A", Symbol: "نماد", Date: 20260908, AllowedMinDate: 20260908, PriceYesterday: 1000, PriceFirst: 970,
    PriceMin: 970, PriceLast: 1020, PriceClose: 985, AllowedMin: 970,
    ...overrides,
  });

  const exact = build();
  assert.ok(exact);
  assert.equal(exact.closeChangePct, -1.5);
  assert.equal(exact.lastCloseGapPct, 3.55);
  assert.equal(isSellQueueToPositive(exact), true);

  const neverQueued = build({ PriceMin: 980 });
  const positiveClose = build({ PriceClose: 1005 });
  const negativeLast = build({ PriceLast: 995 });
  assert.ok(neverQueued && positiveClose && negativeLast);
  assert.equal(isSellQueueToPositive(neverQueued), false);
  assert.equal(isSellQueueToPositive(positiveClose), false);
  assert.equal(isSellQueueToPositive(negativeLast), false);
});

test("parses TSETMC compact history and keeps the newest official session first", () => {
  const parsed = parseTsetmcTradeHistory(
    "20260816@5130.00@4990.00@5100.00@5130.00@5110.00@4990.00@1@2@3;" +
    "20260815@5150.00@4850.00@4990.00@5020.00@5150.00@5000.00@1@2@3;bad-row",
  );
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    d_even: 20260816, high: 5130, low: 4990, close: 5100,
    last: 5130, open: 5110, yesterday: 4990,
  });
  assert.equal(parsed[1].d_even, 20260815);
});

test("parses the current TSETMC CDN history response", () => {
  const parsed = parseTsetmcDailyHistory({ closingPriceDaily: [
    { dEven: 20260816, priceMax: 5130, priceMin: 4990, pClosing: 5100, pDrCotVal: 5130, priceFirst: 5110, priceYesterday: 4990 },
    { dEven: 20260811, priceMax: 5050, priceMin: 4870, pClosing: 5000, pDrCotVal: 5000, priceFirst: 5050, priceYesterday: 4910 },
  ] });
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    d_even: 20260816, high: 5130, low: 4990, close: 5100,
    last: 5130, open: 5110, yesterday: 4990,
  });
});

test("reports the newest available session instead of the most frequent stale date", () => {
  const stale = Array.from({ length: 20 }, () => [{ d_even: 20260811, close: 100, high: 100 }]);
  const official = [[{ d_even: 20260816, close: 101, high: 101 }]];
  assert.equal(latestMarketDate([...stale, ...official]), 20260816);
});

test("merges market histories without duplicates and lets the official source win", () => {
  const merged = mergeCandlesByDate(
    [
      { d_even: 20260902, close: 120, high: 125 },
      { d_even: 20260901, close: 111, high: 115 },
    ],
    [
      { d_even: 20260901, close: 99, high: 105 },
      { d_even: 20260831, close: 95, high: 100 },
    ],
  );
  assert.deepEqual(merged.map((item) => item.d_even), [20260902, 20260901, 20260831]);
  assert.equal(merged.find((item) => item.d_even === 20260901)?.close, 111);
});

const candles = [
  { d_even: 20260811, close: 4500, high: 4600, yesterday: 4400 },
  { d_even: 20260720, close: 4800, high: 5000, yesterday: 4700 },
  { d_even: 20260513, close: 3000, high: 3200, yesterday: 2950 },
  { d_even: 20260211, close: 2000, high: 2100, yesterday: 1980 },
];

test("normalizes Arabic Persian symbol variants", () => {
  assert.equal(normalizeSymbol("  كفپارس\u200c  "), "کفپارس");
  assert.equal(normalizeSymbol("هم   ارز"), "هم ارز");
});

test("reads multi-column Windows-style watchlist text without breaking multi-word symbols", () => {
  const parsed = parseSymbolList("کفپارس \t5 \t1.83 \t500\r\nهم ارز \t2 \t0 \t100\r\nترنج ثابت\r\nکفپارس");
  assert.deepEqual(parsed, ["کفپارس", "هم ارز", "ترنج ثابت"]);
});

test("ignores copied ranks, prices, percentages and table headers", () => {
  const parsed = parseSymbolList([
    "رتبه\tنماد\tقیمت پایانی\tدرصد",
    "1\tکفپارس\t۵۰۰\t+۲٫۴٪",
    "۲. هم ارز ۱٬۲۹۰ −۳٪",
    "نماد: کحافظ 870 1.2%",
    "کفپارس 500 0%",
  ].join("\n"));
  assert.deepEqual(parsed, ["کفپارس", "هم ارز", "کحافظ"]);
});

test("separates signed period return from positive drawdown magnitude", () => {
  const metrics = calculatePeriod(candles, 90);
  assert.ok(metrics);
  assert.equal(metrics.startPrice, 3000);
  assert.equal(metrics.peakPrice, 5000);
  assert.equal(metrics.currentPrice, 4500);
  assert.equal(metrics.returnPct, 50);
  assert.equal(metrics.drawdownPct, 10);
  assert.equal(metrics.startDate, "20260513");
  assert.equal(metrics.peakDate, "20260720");
  assert.equal(metrics.currentDate, "20260811");
});

test("adjusts history only with an official share-count change", () => {
  const metrics = calculatePeriod(candles, 180, [{ date: 20260701, oldShares: 100, newShares: 200 }]);
  assert.ok(metrics);
  assert.equal(metrics.startPrice, 1500);
  assert.equal(metrics.returnPct, 200);
});

test("uses exact 90 and 180 calendar-day cutoffs", () => {
  assert.equal(subtractCalendarDays(20260815, 90), 20260517);
  assert.equal(subtractCalendarDays(20260815, 180), 20260216);
});

test("selects the first trading session on or after an exact cutoff", () => {
  const period = calculatePeriod([
    { d_even: 20240831, close: 2000, high: 2100 },
    { d_even: 20240305, close: 1000, high: 1100 },
    { d_even: 20240303, close: 900, high: 950 },
  ], 180);
  assert.ok(period);
  assert.equal(period.startDate, "20240305");
  assert.equal(period.returnPct, 100);
});

test("Wilder RSI handles rising and flat histories", () => {
  const rising = Array.from({ length: 20 }, (_, index) => ({
    d_even: 20260101 + index,
    close: 100 + index,
    high: 100 + index,
  })).reverse();
  const flat = rising.map((item) => ({ ...item, close: 100, high: 100 }));
  assert.equal(calculateRsi(rising), 100);
  assert.equal(calculateRsi(flat), 50);
});

test("does not call a price gap a capital increase without share data", () => {
  const gapCandles = [
    { d_even: 20260702, close: 3100, high: 3200, yesterday: 3000 },
    { d_even: 20260630, close: 6000, high: 6100, yesterday: 5900 },
  ];
  const unconfirmed = detectGapActions(gapCandles, [], 20260101);
  assert.equal(unconfirmed[0].confirmed, false);
  assert.equal(unconfirmed[0].kind, "شکاف تعدیل نیازمند بررسی");

  const confirmed = detectGapActions(gapCandles, [{ date: 20260701, oldShares: 100, newShares: 200 }], 20260101);
  assert.equal(confirmed[0].confirmed, true);
  assert.equal(confirmed[0].kind, "افزایش سرمایه");
  assert.equal(confirmed[0].percent, 100);
  assert.equal(confirmed[0].before, 6000);
  assert.equal(confirmed[0].after, 3000);
  assert.equal(confirmed[0].oldShares, 100);
  assert.equal(confirmed[0].newShares, 200);
});

test("uses distinct 30, 60 and 90 day peaks for the short-period selector", () => {
  const history = [
    { d_even: 20260907, close: 100, high: 100 },
    { d_even: 20260815, close: 100, high: 125 },
    { d_even: 20260720, close: 100, high: 200 },
    { d_even: 20260620, close: 100, high: 400 },
  ];
  assert.equal(calculatePeriod(history, 30).drawdownPct, 20);
  assert.equal(calculatePeriod(history, 60).drawdownPct, 50);
  assert.equal(calculatePeriod(history, 90).drawdownPct, 75);
});

test("never turns an undated Zarvan quote into today's trading candle", () => {
  const quote = { PriceMax: 14230, PriceMin: 14140, PriceClose: 14230, Volume: 10121604 };
  assert.equal(candleFromInstrument({ ...quote, Date: 0 }), null);
  assert.equal(candleFromInstrument(quote), null);
  assert.equal(candleFromInstrument({ ...quote, Date: 20260907 }).d_even, 20260907);
  assert.equal(candleFromInstrument({ ...quote, Date: 20260907, Volume: 0 }), null);
});

test("undated snapshot is stamped as the next trading day only when the chain proves it", () => {
  // Real-world shape (کفپارس, session 20260909): history ends 20260908 close=5810,
  // snapshot PriceYesterday=5810, PriceClose=5920, traded 5700..5980.
  const snapshot = { Date: 0, PriceMax: 5980, PriceMin: 5700, PriceClose: 5920, PriceYesterday: 5810, PriceFirst: 5900, PriceLast: 5980, Volume: 36634769 };
  const last = { d_even: 20260908, high: 5810, low: 5700, close: 5810 };

  // Fixed "now": Wednesday 2026-09-09 15:00 Tehran (past 13:00) → the inferred
  // session 20260909 is already closed by Tehran market clock.
  const mondayAfterClose = new Date("2026-09-09T11:30:00Z");
  const candle = candleFromUndatedInstrument(snapshot, last, mondayAfterClose);
  assert.ok(candle, "anchored snapshot must produce a candle");
  assert.equal(candle.d_even, 20260909);
  assert.equal(candle.close, 5920);
  assert.equal(candle.yesterday, 5810);

  // Guard 1: chain broken — PriceYesterday does not match last close.
  assert.equal(candleFromUndatedInstrument({ ...snapshot, PriceYesterday: 5800 }, last, mondayAfterClose), null);

  // Guard 2: restatement of the same session (all prices equal last close).
  const restatement = { ...snapshot, PriceMax: 5810, PriceMin: 5810, PriceClose: 5810 };
  assert.equal(candleFromUndatedInstrument(restatement, last, mondayAfterClose), null);

  // Guard 3: during live hours of the inferred session the candle is not closed yet.
  const mondayDuringTrading = new Date("2026-09-09T07:30:00Z"); // 11:00 Tehran Wednesday
  assert.equal(candleFromUndatedInstrument(snapshot, last, mondayDuringTrading), null);

  // Guard 4: a dated snapshot is not this function's business.
  assert.equal(candleFromUndatedInstrument({ ...snapshot, Date: 20260909 }, last, mondayAfterClose), null);

  // Guard 5: no history → no anchor → refuse.
  assert.equal(candleFromUndatedInstrument(snapshot, undefined, mondayAfterClose), null);

  // Weekend walk: last candle Thursday 2026-09-03 (market closed Thu/Fri next week? no—
  // 2026-09-03 IS a Thursday); next trading day must be Saturday 20260905.
  const thursdayLast = { d_even: 20260903, high: 100, low: 90, close: 95 };
  const snap2 = { ...snapshot, PriceYesterday: 95, PriceClose: 97, PriceMax: 98, PriceMin: 94 };
  const saturdayAfterClose = new Date("2026-09-05T11:30:00Z"); // 15:00 Tehran Saturday
  const weekendCandle = candleFromUndatedInstrument(snap2, thursdayLast, saturdayAfterClose);
  assert.ok(weekendCandle, "weekend skip must land on Saturday");
  assert.equal(weekendCandle.d_even, 20260905);
});

test("watchlist scopes stay independent and the union normalizes and deduplicates", () => {
  const lists = { haghighi: ["كسرام", "کفپارس"], zarbanana: ["کسرام", "سپیدار"], custom: ["هم ارز"] };
  assert.deepEqual(symbolsForScope(lists, "haghighi"), ["کسرام", "کفپارس"]);
  assert.deepEqual(symbolsForScope(lists, "zarbanana"), ["کسرام", "سپیدار"]);
  assert.deepEqual(symbolsForScope(lists, "custom"), ["هم ارز"]);
  assert.deepEqual(symbolsForScope(lists, "all"), ["کسرام", "کفپارس", "سپیدار", "هم ارز"]);
});

test("rejects short table headers and accepts Persian-ranked tab-separated symbols", () => {
  assert.deepEqual(parseSymbolList("رتبه\tنماد\tقیمت\n۱\tکفپارس\t۵۰۰\n۲\tهم ارز\t۱۰۰"), ["کفپارس", "هم ارز"]);
});

test("a missing holding value is unknown, while an explicit zero is a full sale", () => {
  const rows = extractMajorIndividualHoldingChanges({ dates: [20260906, 20260907], shareHoldersChanges: [
    { name: "شخص حقیقی", insList: [{ insCode: "missing", firstDay: 100 }, { insCode: "zero", firstDay: 100, secondDay: 0 }] },
  ] });
  assert.deepEqual(rows.map((row) => row.insCode), ["zero"]);
  assert.equal(rows[0].changeShares, -100);
});
