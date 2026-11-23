import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculatePeriod, calculateRsi, parseTsetmcTradeHistory, parseTsetmcDailyHistory,
} from '../app/lib/market.ts';
import { recalculateScreenerRow } from '../app/lib/screener-analysis.ts';
import { analyzeDivergence, resolveAnalysisAdjustments } from '../app/lib/divergence.ts';
import { findRsiSwingDivergence } from '../app/lib/divergence-patterns.ts';
import { divergenceSeries, asOf } from './helpers/divergence-series.mjs';

const day = (index) => Number(new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10).replaceAll('-', ''));

test('extreme reference gap on the SECOND recorded day is not mistaken for a fresh listing', () => {
  const candles = Array.from({ length: 30 }, (_, i) => ({
    d_even: day(i), close: i ? 400 : 1000, high: i ? 410 : 1010,
    low: i ? 390 : 990, yesterday: i === 1 ? 400 : (i ? 400 : 1000),
  }));
  assert.deepEqual(resolveAnalysisAdjustments(candles, []).unresolved, [day(1)]);
});

test('a close move without a reference is not mislabeled as an evidenced corporate action', () => {
  const candles = [
    { d_even: day(0), close: 1000, high: 1010, low: 990 },
    { d_even: day(1), close: 400, high: 410, low: 390 },
  ];
  assert.deepEqual(resolveAnalysisAdjustments(candles, []).unresolved, []);
});

test('90/180-day calculations withhold unadjusted returns across unresolved scale breaks', () => {
  const candles = Array.from({ length: 100 }, (_, i) => {
    const close = i < 70 ? 1000 : 400;
    const yesterday = i === 70 ? 400 : close;
    return { d_even: day(i), close, last: close, high: close + 10, low: close - 10, yesterday };
  });
  const row = {
    symbol: 'تست', rsi: null, realHolders: null, three: null, six: null,
    actions: [], status: 'ready',
    analysisInput: { candles, changes: [], eps: 1, pe: 5, sectorPe: 7 },
  };
  assert.equal(calculatePeriod(candles, 90)?.returnPct, -60, 'baseline would publish a split-induced price crash');
  const recalculated = recalculateScreenerRow(row, candles, [], true, asOf(candles));
  assert.equal(recalculated.three, null);
  assert.equal(recalculated.six, null);
  assert.equal(recalculated.status, 'warning');
  assert.match(recalculated.note ?? '', /تعدیل/);
});

test('the same split with matching official shares keeps the corrected 90/180-day returns', () => {
  // Supply enough dated history to genuinely cover 180 days. A 100-day
  // example is insufficient for a 180-day metric even if adjustments are right.
  const candles = Array.from({ length: 220 }, (_, i) => {
    const close = i < 70 ? 1000 : 400;
    return { d_even: day(i), close, last: close, high: close + 10, low: close - 10, yesterday: close };
  });
  const changes = [{ date: day(70), oldShares: 100, newShares: 250 }];
  const row = {
    symbol: 'تست', rsi: null, realHolders: null, three: null, six: null,
    actions: [], status: 'ready',
    analysisInput: { candles, changes, eps: 1, pe: 5, sectorPe: 7 },
  };
  const recalculated = recalculateScreenerRow(row, candles, changes, true, asOf(candles));
  assert.equal(recalculated.three?.returnPct, 0);
  assert.equal(recalculated.six?.returnPct, 0);
  assert.equal(recalculated.three?.startPrice, 400);
});

test('an unresolved gap outside the shorter lookback preserves 30/60-day figures', () => {
  const candles = Array.from({ length: 100 }, (_, i) => {
    const close = i < 20 ? 1000 : 400;
    return { d_even: day(i), close, last: close, high: close + 10, low: close - 10, yesterday: close };
  });
  const row = {
    symbol: 'تست', rsi: null, realHolders: null, three: null, six: null,
    actions: [], status: 'ready',
    analysisInput: { candles, changes: [], eps: 1, pe: 5, sectorPe: 7 },
  };
  const recalculated = recalculateScreenerRow(row, candles, [], true, asOf(candles));
  assert.equal(recalculated.three, null);
  assert.equal(recalculated.six, null);
  assert.equal(recalculated.peakDrops['1m']?.returnPct, 0);
  assert.equal(recalculated.peakDrops['2m']?.returnPct, 0);
});

test('invalid or insufficient candle prices cannot manufacture period returns or peaks', () => {
  const valid = { d_even: 20260907, close: 100, high: 110, low: 90 };
  // The existing API contract exposes the last verified price even when only
  // one session is available. Its zero return remains a coverage limitation.
  assert.equal(calculatePeriod([valid], 90)?.currentPrice, 100);
  assert.equal(calculatePeriod([valid], 90)?.returnPct, 0);
  assert.equal(calculatePeriod([valid, { d_even: 20260901, close: 0, high: 100, low: 90 }], 90), null);
  assert.equal(calculatePeriod([valid, { d_even: 20260901, close: 80, high: NaN, low: 70 }], 90), null);
  assert.equal(calculatePeriod([valid, { d_even: 20260901, close: 80, high: 75, low: 70 }], 90), null);
});

test('RSI stops at invalid historical closes instead of compressing out the missing session', () => {
  const candles = Array.from({ length: 23 }, (_, i) => ({
    d_even: day(i), close: i === 7 ? NaN : 100 + i, high: 110 + i,
  }));
  assert.equal(calculateRsi(candles, 12), null);
  assert.equal(calculateRsi(candles, 0), null);
});

test('nonexistent Gregorian sessions never enter either TSETMC history parser', () => {
  const compact = '20260230@110@90@100@100@100@100@1@2@3;20260228@110@90@100@100@100@100@1@2@3';
  assert.deepEqual(parseTsetmcTradeHistory(compact).map((c) => c.d_even), [20260228]);
  const json = { closingPriceDaily: [
    { dEven: 20260230, priceMax: 110, priceMin: 90, pClosing: 100 },
    { dEven: 20260228, priceMax: 110, priceMin: 90, pClosing: 100 },
  ] };
  assert.deepEqual(parseTsetmcDailyHistory(json).map((c) => c.d_even), [20260228]);
});

test('official history excludes impossible OHLC and explicitly non-traded pre-created rows', () => {
  const compact = '20261021@90@100@95@95@95@95@1@10@1;20261021@110@90@100@100@100@100@1@0@1';
  assert.deepEqual(parseTsetmcTradeHistory(compact), []);
  const json = { closingPriceDaily: [
    { dEven: 20261021, priceMax: 90, priceMin: 100, pClosing: 95, qTotTran5J: 100 },
    { dEven: 20261021, priceMax: 110, priceMin: 90, pClosing: 100, qTotTran5J: 0 },
    { dEven: 20261021, priceMax: 110, priceMin: 90, pClosing: 100, qTotTran5J: 200 },
    // A genuinely future (unclosed) slot, regardless of when this suite runs.
    { dEven: 20271126, priceMax: 110, priceMin: 90, pClosing: 100, qTotTran5J: 200 },
  ] };
  assert.deepEqual(parseTsetmcDailyHistory(json).map((c) => c.d_even), [20261021]);
});

test('contradictory daily high/low must be unverified, not a credible absence of divergence', () => {
  const candles = divergenceSeries(false);
  candles[80] = { ...candles[80], high: candles[80].close - 0.1 };
  assert.equal(analyzeDivergence(candles, [], 90, { now: asOf(candles) }).status, 'unverified');
});

test('swing lookback includes BOTH price pivots, never only the newer extreme', () => {
  const bars = Array.from({ length: 45 }, (_, i) => ({
    date: Number(new Date(Date.UTC(2026, 0, 1 + i * 3)).toISOString().slice(0, 10).replaceAll('-', '')),
    close: 110, high: 111, low: 109,
  }));
  bars[25].low = 82; bars[25].close = 82.5;
  bars[35].low = 76; bars[35].close = 76.5;
  const rsi = bars.map(() => 50);
  rsi[25] = 22; rsi[35] = 35;
  assert.equal(findRsiSwingDivergence(bars, rsi, 60)?.code, 'RD+');
  assert.equal(findRsiSwingDivergence(bars, rsi, 50), null);
});
