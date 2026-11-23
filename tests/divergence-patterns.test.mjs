import test from 'node:test';
import assert from 'node:assert/strict';
import { findRsiSwingDivergence } from '../app/lib/divergence-patterns.ts';
import { analyzeDivergence, detectDivergence } from '../app/lib/divergence.ts';
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

for (const [code, first, second, rsi1, rsi2, side, trend] of [
  ['RD+', 82, 76, 22, 35, 'low', 0],
  ['RD-', 138, 144, 78, 60, 'high', 0],
  ['HD+', 90, 94, 36, 25, 'low', 0.8],
  ['HD-', 138, 133, 66, 82, 'high', -0.6],
]) {
  test(`detects ${code} from two confirmed price swings and matched RSI extrema`, () => {
    const { bars, rsi } = sample(first, second, rsi1, rsi2, side, trend);
    const result = findRsiSwingDivergence(bars, rsi, 90);
    assert.equal(result?.code, code, JSON.stringify(result));
    assert.equal(result?.previous.index, 25);
    assert.equal(result?.latest.index, 35);
    assert.equal(result?.confirmationDate, bars[37].date);
    assert.equal(result?.type, code.startsWith('RD') ? 'regular' : 'hidden');
  });
}

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

test('hidden patterns require the pre-existing main trend', () => {
  const noUptrend = sample(82, 86, 35, 25, 'low', 0);
  assert.equal(findRsiSwingDivergence(noUptrend.bars, noUptrend.rsi, 90), null);
  const noDowntrend = sample(142, 139, 65, 75, 'high', 0);
  assert.equal(findRsiSwingDivergence(noDowntrend.bars, noDowntrend.rsi, 90), null);
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
