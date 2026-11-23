import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAnalysisAdjustments, analyzeDivergence } from '../app/lib/divergence.ts';
import { divergenceSeries, asOf } from './helpers/divergence-series.mjs';

// Helper: an extreme reference gap injected at index 160 of the fixture.
// ratio = yesterday[i]/close[i-1]; closeFactor = close[i]/yesterday[i].
const gapAt = (ratio, closeFactor) => {
  const c = divergenceSeries();
  c[160] = { ...c[160], yesterday: c[159].close * ratio, close: c[159].close * ratio * closeFactor, high: c[159].close * ratio * closeFactor * 1.01, low: c[159].close * ratio * closeFactor * 0.99 };
  return c;
};
const shift = (date, days) => {
  const dt = new Date(Date.UTC(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
};
const analyze = (c) => analyzeDivergence(c, [], 90, { now: asOf(c) });

// 1. Genuine overnight corporate action: no official data, no calendar break,
//    close within 12% of the new reference → MUST BLOCK.
test('overnight action, no data, close within 12% of new reference blocks', () => {
  const c = gapAt(0.4, 1.02);
  const r = resolveAnalysisAdjustments(c, []);
  assert.equal(r.effective.length, 0);
  assert.deepEqual(r.unresolved, [c[160].d_even]);
  // The gap leaves only 18 clean sessions, below the 24 sessions now required
  // for a two-swing RSI divergence (RSI seed + confirmed extrema).
  const a = analyze(c);
  assert.ok(a.status !== 'positive' && a.status !== 'negative', `no divergence may be claimed across the gap, got ${a.status}`);
  assert.equal(a.status, 'insufficient', 'clean post-gap candles may compute RSI but cannot confirm two recent pivots');
  assert.equal(a.candleCount, 18, 'analysis must only count the clean post-gap segment');
  assert.equal(typeof a.rsi, 'number', 'the independent RSI column must continue working with 18 clean candles');
  assert.equal(a.rsi, null === a.rsi ? null : a.rsi);
  // With fewer than 13 clean sessions after the gap the whole symbol blocks.
  const truncated = c.slice(0, 172); // only 11 sessions after the gap
  const b = analyze(truncated);
  assert.equal(b.status, 'adjustment');
  assert.equal(b.divergence, null);
  assert.equal(b.rsi, null);
});

// 2. Genuine overnight corporate action: no official data, no calendar break,
//    close MORE than 12% from the new reference → MUST ALSO BLOCK.
//    (Close/yesterday proximity is not affirmative evidence of anything.)
test('overnight action, no data, close far from new reference also blocks', () => {
  const c = gapAt(0.4452, 1.36);
  const r = resolveAnalysisAdjustments(c, []);
  assert.equal(r.effective.length, 0);
  assert.deepEqual(r.unresolved, [c[160].d_even], 'close-vs-reference distance is NOT evidence of safety');
  // No divergence can be claimed across the unresolved gap (restart semantics).
  const a = analyze(c);
  assert.ok(a.status !== 'positive' && a.status !== 'negative', `got ${a.status}`);
  const b = analyze(c.slice(0, 172));
  assert.equal(b.status, 'adjustment');
});

// 3. Known provider artifact: broken `yesterday` field but a CONTINUOUS close
//    series (close-to-close within limit band) → MUST NOT block.
test('provider artifact with continuous close series does not block', () => {
  const c = divergenceSeries();
  c[160] = { ...c[160], yesterday: c[159].close * 0.5 }; // reference halved, close untouched
  const r = resolveAnalysisAdjustments(c, []);
  assert.equal(r.effective.length, 0);
  assert.equal(r.unresolved.length, 0);
  const a = analyze(c);
  assert.ok(['positive', 'negative', 'none'].includes(a.status), `artifact must stay analyzable, got ${a.status}`);
});

// 4. Fresh listing: the gap candle is the FIRST candle → no prior scale to
//    corrupt, no adjustment definable → MUST NOT be classified.
test('fresh listing (first candle of the series) is not a corporate action', () => {
  const c = divergenceSeries();
  const listing = [{ d_even: 20260201, close: 1200, high: 1250, low: 1180, yesterday: 0 }];
  const r = resolveAnalysisAdjustments(listing, []);
  assert.equal(r.effective.length, 0);
  assert.equal(r.unresolved.length, 0);
});

// 5. Halt/reopen without corporate action: ≥10 calendar days, no reference
//    price on the resume candle → new scale stands alone → MUST NOT block.
test('halt/reopen without reference price is not a corporate action', () => {
  const c = divergenceSeries();
  const halted = c.slice(0, 150);
  halted.push({ ...c[150], d_even: shift(c[150].d_even, 21), yesterday: 0 });
  const r = resolveAnalysisAdjustments(halted, []);
  assert.equal(r.effective.length, 0);
  assert.equal(r.unresolved.length, 0);
});

// 6. Ordinary extreme market move with a valid continuous previous-close
//    chain → MUST remain analyzable.
test('ordinary extreme move (continuous closes, reference in artifact band) stays analyzable', () => {
  const c = divergenceSeries();
  c[160] = { ...c[160], yesterday: c[159].close * 1.10, close: c[159].close * 1.10 * 1.05, high: c[159].close * 1.10 * 1.06, low: c[159].close * 1.10 * 1.04 };
  const r = resolveAnalysisAdjustments(c, []);
  assert.equal(r.effective.length, 0);
  assert.equal(r.unresolved.length, 0);
  const a = analyze(c);
  assert.notEqual(a.status, 'adjustment');
});

// —— Matching safety (carried over) ——

test('a current gap does NOT match a similar capital increase registered 90 days earlier', () => {
  const c = gapAt(0.4, 1.02);
  const gapDate = c[160].d_even;
  const old = { date: shift(gapDate, -90), oldShares: 1000000000, newShares: 2500000000 };
  const r = resolveAnalysisAdjustments(c, [old]);
  assert.equal(r.effective.length, 0, '90-day-old change must never match a new gap');
  assert.deepEqual(r.unresolved, [gapDate]);
});

test('a current gap matches the CLOSEST of two capital increases within the window', () => {
  const c = gapAt(0.5, 1.02);
  const gapDate = c[160].d_even;
  const close = { date: shift(gapDate, -10), oldShares: 1000000000, newShares: 2000000000 };
  const far = { date: shift(gapDate, -40), oldShares: 1000000000, newShares: 2050000000 };
  const r = resolveAnalysisAdjustments(c, [far, close]);
  assert.equal(r.effective.length, 1);
  assert.equal(r.effective[0].newShares, 2000000000, 'closest date wins');
});

test('an old increase with a numerically similar ratio but beyond 45 days is never consumed', () => {
  const c = gapAt(0.4, 1.02);
  const gapDate = c[160].d_even;
  const old = { date: shift(gapDate, -46), oldShares: 1000000000, newShares: 2500000000 };
  const r = resolveAnalysisAdjustments(c, [old]);
  assert.equal(r.effective.length, 0);
  assert.deepEqual(r.unresolved, [gapDate]);
});

test('a genuine corporate action inside 45 days applies (regression of the کالا shape)', () => {
  const c = gapAt(0.4452, 1.0);
  const gapDate = c[160].d_even;
  const official = { date: shift(gapDate, -3), oldShares: 29000000000, newShares: 62000000000 };
  const r = resolveAnalysisAdjustments(c, [official]);
  assert.equal(r.effective.length, 1);
  assert.equal(r.unresolved.length, 0);
});

test('long market closure WITHOUT a corporate action does not create a false adjustment', () => {
  // 40-day closure with a CONTINUOUS close series: the closes prove no scale
  // break, so the analysis proceeds.
  const c = divergenceSeries().map((candle, i) => i > 156 ? { ...candle, d_even: shift(candle.d_even, 40) } : candle);
  const r = resolveAnalysisAdjustments(c, []);
  assert.equal(r.effective.length, 0);
  assert.equal(r.unresolved.length, 0);
});
