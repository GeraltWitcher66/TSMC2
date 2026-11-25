import test from 'node:test';
import assert from 'node:assert/strict';
import { findRsiSwingDivergence } from '../app/lib/divergence-patterns.ts';
import { analyzeDivergence, detectDivergence, wilderRsi } from '../app/lib/divergence.ts';
import { divergenceSeries, asOf } from './helpers/divergence-series.mjs';

function sample(firstPrice, secondPrice, firstRsi, secondRsi, side, trend = 0) {
  const bars = Array.from({ length: 45 }, (_, i) => {
    const baseline = 110 + trend * i;
    const date = Number(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10).replaceAll('-', ''));
    return { date, close: baseline, high: baseline + 1, low: baseline - 1 };
  });
  for (const [idx, price] of [[25, firstPrice], [35, secondPrice]]) {
    bars[idx][side] = price;
    bars[idx].close = side === 'low' ? price + 0.5 : price - 0.5;
  }
  const rsi = bars.map(() => 50);
  rsi[25] = firstRsi;
  rsi[35] = secondRsi;
  return { bars, rsi };
}

function swingBars(total, points, side) {
  const bars = Array.from({ length: total }, (_, i) => {
    const date = Number(new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10).replaceAll('-', ''));
    return { date, close: 110, high: 111, low: 109 };
  });
  for (const [index, price] of points) {
    bars[index][side] = price;
    bars[index].close = side === 'low' ? price + 0.5 : price - 0.5;
  }
  return bars;
}

for (const [code, first, second, rsi1, rsi2, side] of [
  ['RD+', 82, 76, 22, 35, 'low'],
  ['RD-', 138, 144, 78, 60, 'high'],
]) {
  test(`detects ${code} from two confirmed price swings and matched RSI extrema`, () => {
    const { bars, rsi } = sample(first, second, rsi1, rsi2, side);
    const result = findRsiSwingDivergence(bars, rsi, 90);
    assert.equal(result?.code, code, JSON.stringify(result));
    assert.equal(result?.previous.index, 25);
    assert.equal(result?.latest.index, 35);
    assert.equal(result?.confirmationDate, bars[37].date);
    assert.equal(result?.type, 'regular');
    assert.equal(result?.label, code === 'RD+' ? 'واگرایی مثبت' : 'واگرایی منفی');
  });
}

test('higher price low with lower RSI low is not a divergence', () => {
  const { bars, rsi } = sample(90, 94, 36, 25, 'low', 0.8);
  assert.equal(findRsiSwingDivergence(bars, rsi, 90), null);
});

test('lower price high with higher RSI high is not a divergence', () => {
  const { bars, rsi } = sample(138, 133, 66, 82, 'high', -0.6);
  assert.equal(findRsiSwingDivergence(bars, rsi, 90), null);
});

test('two equal consecutive highs form one pivot on the first candle', () => {
  const bars = swingBars(45, [[25, 138], [34, 144], [35, 144]], 'high');
  const rsi = bars.map(() => 50);
  rsi[25] = 78;
  rsi[34] = 60;
  rsi[35] = 60;
  const result = findRsiSwingDivergence(bars, rsi, 90);
  assert.equal(result?.code, 'RD-', JSON.stringify(result));
  assert.equal(result?.previous.index, 25);
  assert.equal(result?.latest.index, 34);
});

test('a pivot eleven sessions old no longer produces a signal', () => {
  const stale = swingBars(45, [[25, 138], [33, 144]], 'high');
  const staleRsi = stale.map(() => 50);
  staleRsi[25] = 78;
  staleRsi[33] = 60;
  assert.equal(stale.length - 1 - 33, 11);
  assert.equal(findRsiSwingDivergence(stale, staleRsi, 90), null);
  const fresh = swingBars(45, [[25, 138], [34, 144]], 'high');
  const freshRsi = fresh.map(() => 50);
  freshRsi[25] = 78;
  freshRsi[34] = 60;
  assert.equal(fresh.length - 1 - 34, 10);
  assert.equal(findRsiSwingDivergence(fresh, freshRsi, 90)?.code, 'RD-');
});

test('unconfirmed latest swing never becomes a divergence (no future leakage)', () => {
  const { bars, rsi } = sample(82, 76, 22, 35, 'low');
  assert.equal(findRsiSwingDivergence(bars.slice(0, 37), rsi.slice(0, 37), 90), null);
  assert.equal(findRsiSwingDivergence(bars.slice(0, 38), rsi.slice(0, 38), 90)?.code, 'RD+');
});

test('same-direction moves, RSI equality and tiny noise are not divergence', () => {
  const aligned = sample(82, 76, 22, 18, 'low');
  assert.equal(findRsiSwingDivergence(aligned.bars, aligned.rsi, 90), null);
  const flat = sample(82, 76, 22, 22, 'low');
  assert.equal(findRsiSwingDivergence(flat.bars, flat.rsi, 90), null);
  const noise = sample(82, 81.95, 22, 28, 'low');
  assert.equal(findRsiSwingDivergence(noise.bars, noise.rsi, 90), null);
});

test('old or too-distant pivots, invalid OHLC, and missing RSI cannot produce a confirmed pattern', () => {
  const original = sample(82, 76, 22, 35, 'low');
  assert.equal(findRsiSwingDivergence(original.bars, original.rsi, 90, { maximumSignalAgeBars: 4 }), null);
  assert.equal(findRsiSwingDivergence(original.bars, original.rsi, 1), null);
  const badBars = original.bars.map((b) => ({ ...b }));
  badBars[35].low = NaN;
  assert.equal(findRsiSwingDivergence(badBars, original.rsi, 90), null);
  const badRsi = [...original.rsi];
  for (let i = 23; i <= 27; i++) badRsi[i] = null;
  assert.equal(findRsiSwingDivergence(original.bars, badRsi, 90), null);
});

test('breaking the newer pivot extreme invalidates an earlier confirmed warning', () => {
  const { bars, rsi } = sample(82, 76, 22, 35, 'low');
  assert.equal(findRsiSwingDivergence(bars, rsi, 90)?.code, 'RD+');
  const breached = bars.map((b) => ({ ...b }));
  breached[43].low = 74;
  breached[43].close = 74.5;
  assert.equal(findRsiSwingDivergence(breached, rsi, 90), null);
});

test('realistic close-series history yields RD+ and RD- and retains serialized evidence', () => {
  for (const [bearish, expected] of [[false, 'RD+'], [true, 'RD-']]) {
    const candles = divergenceSeries(bearish);
    const analysis = analyzeDivergence(candles, [], 90, { now: asOf(candles) });
    assert.equal(analysis.divergence?.code, expected);
    assert.equal(analysis.divergence?.confirmationDate > analysis.divergence?.latest.date, true);
    assert.deepEqual(detectDivergence(candles, [], 90, { now: asOf(candles) }), analysis.divergence);
    assert.deepEqual(JSON.parse(JSON.stringify(analysis)), analysis);
  }
});

test('divergence RSI basis is configurable and defaults to the closing price', () => {
  const candles = divergenceSeries(false);
  const onClose = analyzeDivergence(candles, [], 90, { now: asOf(candles) });
  assert.equal(onClose.divergence?.code, 'RD+');
  const closeRsi = wilderRsi(candles.map((c) => c.close), 12).at(-1);
  assert.equal(onClose.divergenceRsi, Math.round(closeRsi * 10000) / 10000);
  // The helper keeps last == close; move one last trade so the two bases differ.
  const varied = candles.map((c) => ({ ...c }));
  varied[candles.length - 3].last *= 1.04;
  const onLast = analyzeDivergence(varied, [], 90, { now: asOf(varied), rsiSource: 'last' });
  const lastRsi = wilderRsi(varied.map((c) => c.last), 12).at(-1);
  assert.equal(onLast.divergenceRsi, Math.round(lastRsi * 10000) / 10000);
  assert.notEqual(onLast.divergenceRsi, onClose.divergenceRsi);
});

test('intraday last candle does not leak into closed RSI pivot comparison', () => {
  const candles = divergenceSeries(false);
  const now = asOf(candles);
  const before = analyzeDivergence(candles, [], 90, { now });
  const d = new Date(now);
  const tomorrow = new Date(d.getTime() + 86400000);
  const asDate = Number(tomorrow.toISOString().slice(0, 10).replaceAll('-', ''));
  const extended = [...candles, { ...candles.at(-1), d_even: asDate, high: 999, low: 1, close: 999, last: 999 }];
  const after = analyzeDivergence(extended, [], 90, { now });
  assert.deepEqual(after.divergence, before.divergence);
});
