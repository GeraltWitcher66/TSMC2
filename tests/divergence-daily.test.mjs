import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDivergence, detectDivergence, wilderRsi, resolveAnalysisAdjustments, classifyDailyDivergence } from '../app/lib/divergence.ts';
import { divergenceSeries, asOf } from './helpers/divergence-series.mjs';

// Updated contract: technical divergence requires two CONFIRMED price swings,
// not a comparison of two successive closing-price/RSI observations.

test('regular positive: lower price low + higher close-RSI low', () => {
  const candles = divergenceSeries(false);
  const result = analyzeDivergence(candles, [], 90, { now: asOf(candles) });
  assert.equal(result.status, 'positive');
  assert.equal(result.divergence?.code, 'RD+');
  assert.ok(result.divergence.latest.price < result.divergence.previous.price);
  assert.ok(result.divergence.latest.rsi > result.divergence.previous.rsi);
  assert.ok(result.divergence.confirmationDate > result.divergence.latest.date);
});

test('regular negative: higher price high + lower close-RSI high', () => {
  const candles = divergenceSeries(true);
  const result = analyzeDivergence(candles, [], 90, { now: asOf(candles) });
  assert.equal(result.status, 'negative');
  assert.equal(result.divergence?.code, 'RD-');
  assert.ok(result.divergence.latest.price > result.divergence.previous.price);
  assert.ok(result.divergence.latest.rsi < result.divergence.previous.rsi);
});

test('two consecutive opposite movements alone are NOT confirmed divergence', () => {
  const start = Date.UTC(2026, 0, 1);
  const candles = Array.from({ length: 35 }, (_, i) => {
    const close = 100 + i * 0.2;
    return { d_even: Number(new Date(start + i * 86400000).toISOString().slice(0, 10).replaceAll('-', '')),
      close, last: close, high: close + 1, low: close - 1, open: close };
  });
  candles[34] = { ...candles[34], last: 78 };
  const analysis = analyzeDivergence(candles, [], 90, { now: new Date('2026-02-07T12:00:00Z') });
  assert.equal(analysis.status, 'none');
  assert.equal(analysis.divergence, null);
});

test('closed-session selection excludes unfinished and future candles', () => {
  const candles = divergenceSeries(false);
  const now = asOf(candles);
  const before = analyzeDivergence(candles, [], 90, { now });
  const tomorrow = new Date(now.getTime() + 86400000);
  const nextDate = Number(tomorrow.toISOString().slice(0, 10).replaceAll('-', ''));
  const added = [...candles, { ...candles.at(-1), d_even: nextDate, high: 999, low: 1, close: 999, last: 999 }];
  const after = analyzeDivergence(added, [], 90, { now });
  assert.deepEqual(after.divergence, before.divergence);
  assert.equal(after.asOfDate, before.asOfDate);
});

test('insufficient closed candles cannot produce a swing pattern', () => {
  const c = divergenceSeries(false).slice(0, 12);
  const result = analyzeDivergence(c, [], 90, { now: asOf(c) });
  assert.equal(result.status, 'insufficient');
  assert.equal(result.divergence, null);
});

test('13 to 23 valid sessions preserve the legacy table RSI without claiming a divergence', () => {
  const c = divergenceSeries(false).slice(0, 19);
  const result = analyzeDivergence(c, [], 90, { now: asOf(c) });
  assert.equal(result.status, 'insufficient');
  assert.equal(result.divergence, null);
  assert.equal(typeof result.rsi, 'number');
  assert.equal(result.rsi, Math.round(wilderRsi(c.map((bar) => bar.last), 12).at(-1) * 10000) / 10000);
});

test('invalid duplicate close or last values for the same date are rejected', () => {
  const c = divergenceSeries(false);
  assert.equal(analyzeDivergence([...c, { ...c.at(-1), close: 999 }], [], 90, { now: asOf(c) }).status, 'invalid');
  assert.equal(analyzeDivergence([...c, { ...c.at(-1), last: 999 }], [], 90, { now: asOf(c) }).status, 'invalid');
});

test('invalid closing price is rejected', () => {
  const c = divergenceSeries(false);
  c[c.length - 1] = { ...c.at(-1), close: 0 };
  assert.equal(analyzeDivergence(c, [], 90, { now: asOf(c) }).status, 'invalid');
});

test('old market data does not issue an actionable pattern', () => {
  const c = divergenceSeries(false);
  const result = analyzeDivergence(c, [], 90, { now: new Date('2027-01-01T12:00:00Z') });
  assert.equal(result.status, 'stale');
  assert.equal(result.divergence, null);
});

test('missing or invalid high/low data cannot certify price swing', () => {
  const c = divergenceSeries(false);
  c[c.length - 8] = { ...c.at(-8), low: undefined };
  const result = analyzeDivergence(c, [], 90, { now: asOf(c) });
  assert.equal(result.status, 'unverified');
  assert.equal(result.divergence, null);
});

test('unresolved large corporate-action discontinuity blocks RSI pattern', () => {
  const c = divergenceSeries(false);
  const index = c.length - 1, prev = c[index - 1];
  c[index] = { ...c[index], close: prev.close * 0.42, last: prev.last * 0.42,
    low: prev.low * 0.4, high: prev.high * 0.44, yesterday: prev.close * 0.42 };
  assert.ok(resolveAnalysisAdjustments(c, []).unresolved.length > 0);
  const result = analyzeDivergence(c, [], 90, { now: asOf(c) });
  assert.equal(result.status, 'adjustment');
  assert.equal(result.divergence, null);
});

test('serialized API evidence and the detectDivergence facade agree', () => {
  const c = divergenceSeries(false);
  const options = { now: asOf(c) };
  const analysis = analyzeDivergence(c, [], 90, options);
  assert.deepEqual(JSON.parse(JSON.stringify(analysis)), analysis);
  assert.deepEqual(detectDivergence(c, [], 90, options), analysis.divergence);
});

test('RSI table retains last-trade basis; divergence RSI is based on adjusted closes', () => {
  const c = divergenceSeries(false);
  c[c.length - 2].last *= 0.98;
  c[c.length - 1].last *= 1.03;
  const result = analyzeDivergence(c, [], 90, { now: asOf(c) });
  const lastRsi = wilderRsi(c.map((item) => item.last), 12);
  const closeRsi = wilderRsi(c.map((item) => item.close), 12);
  assert.equal(result.rsi, Math.round(lastRsi.at(-1) * 10000) / 10000);
  assert.equal(result.divergenceRsi, Math.round(closeRsi.at(-1) * 10000) / 10000);
  assert.notEqual(result.rsi, result.divergenceRsi);
});

test('legacy day-to-day direction function is diagnostic-only and not used as the signal', () => {
  assert.equal(classifyDailyDivergence(200, 220, 45, 42), 'negative');
  const c = divergenceSeries(false);
  assert.equal(analyzeDivergence(c, [], 90, { now: asOf(c) }).divergence?.code, 'RD+');
});
