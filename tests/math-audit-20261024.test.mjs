import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePeriod, detectGapActions } from '../app/lib/market.ts';
import { resolveAnalysisAdjustments, wilderRsi } from '../app/lib/divergence.ts';
import { recalculateScreenerRow } from '../app/lib/screener-analysis.ts';

// Deterministic, entirely synthetic counterparts of the four 2026-10-24 audit
// scenarios. Dates are settled Tehran sessions, with no real ticker data.
const now = new Date('2026-10-21T14:00:00Z');
const sessions = [];
for (let date = new Date('2026-05-01T00:00:00Z'); date <= now; date.setUTCDate(date.getUTCDate() + 1)) {
  if (date.getUTCDay() === 4 || date.getUTCDay() === 5) continue;
  sessions.push(Number(date.toISOString().slice(0, 10).replaceAll('-', '')));
}
const actionIndex = 50;
const actionDate = sessions[actionIndex];
const stock = (candles, changes = []) => ({
  symbol: 'AUDIT', rsi: null, realHolders: null, three: null, six: null, actions: [], status: 'ready',
  analysisInput: { candles, changes, eps: 10, pe: 5, sectorPe: 7 },
});
const flat = (earlier, later, reference = later) => sessions.map((d_even, i) => {
  const close = i < actionIndex ? earlier : later;
  return { d_even, close, last: close, high: close * 1.01, low: close * 0.99,
    yesterday: i === actionIndex ? reference : close };
});
const screen = (candles, changes = []) => recalculateScreenerRow(stock(candles, changes), candles, changes, true, now);

test('F1: 25% official share increase is matched before extreme-gap filtering and adjusts returns plus RSI', () => {
  const candles = flat(1000, 800);
  const changes = [{ date: actionDate, oldShares: 100, newShares: 125 }];
  const resolved = resolveAnalysisAdjustments(candles, changes);
  assert.deepEqual(resolved.unresolved, []);
  assert.deepEqual(resolved.effective, changes);
  const result = screen(candles, changes);
  assert.equal(calculatePeriod(candles, 180).returnPct, -20, 'raw ratio is a misleading price move');
  assert.equal(result.six?.returnPct, 0);
  assert.equal(result.three?.returnPct, 0);
  assert.equal(result.rsi, 50, 'flat adjusted last trades must seed a neutral Wilder RSI');
  assert.equal(wilderRsi(candles.map((c) => c.last), 12).at(-1), 0, 'unadjusted RSI would wrongly signal oversold');
  assert.equal(result.actions.length, 1);
  assert.equal(result.actions[0].percent, 25);
  assert.equal(result.actions[0].confirmed, true);
});

test('F2: 65 days of historical data cannot claim a complete 90- or 180-day return', () => {
  const partial = sessions.slice(-48).map((d_even, i) => {
    const close = 1000 + i * 10;
    return { d_even, close, last: close, high: close + 10, low: close - 10,
      yesterday: i ? close - 10 : close };
  });
  assert.equal(calculatePeriod(partial, 180)?.returnPct, 47, 'legacy primitive still computes earliest available');
  const result = screen(partial);
  assert.equal(result.three, null, '90-day metric needs 90-day source coverage');
  assert.equal(result.six, null, '180-day metric needs 180-day source coverage');
  assert.equal(result.status, 'warning');
  assert.match(result.note, /پوشش|سابقه|روز/);
  assert.ok(result.peakDrops['1m'], 'covered shorter period remains available');
  assert.ok(result.peakDrops['2m'], 'covered shorter period remains available');
});

test('F2: a one-session dated quote keeps its real current price but cannot fake 90/180-day opening prices', () => {
  const only = [{ d_even: 20261021, close: 3140, last: 3140, high: 3160, low: 3100, yesterday: 3130 }];
  const result = screen(only);
  assert.equal(result.priceQuote?.closeRial, 3140);
  assert.equal(result.priceQuote?.sessionDate, 20261021);
  assert.equal(result.three, null, 'one day cannot establish a ninety-day opening price');
  assert.equal(result.six, null, 'one day cannot establish a 180-day opening price');
  assert.equal(result.status, 'warning', 'one sample is not a validated historical signal');
});

test('F2: old rows in a 260-candle-like feed cannot mask a giant gap at the 180-day boundary', () => {
  // 28 Oct minus 90 days -> 30 July (8 Aug is close enough).
  // 28 Oct minus 180 days -> 1 May (8 Aug is much too late).
  const sparse = [
    { d_even: 20261028, close: 120, high: 125, low: 118, yesterday: 119 },
    { d_even: 20261014, close: 119, high: 124, low: 117, yesterday: 117 },
    { d_even: 20260901, close: 110, high: 112, low: 108, yesterday: 110 },
    { d_even: 20260808, close: 100, high: 102, low: 99, yesterday: 100 },
    { d_even: 20250412, close: 100, high: 102, low: 99, yesterday: 100 },
  ];
  assert.equal(calculatePeriod(sparse, 180)?.startDate, '20260808', 'the naive calculator does not test cutoff coverage');
  const result = recalculateScreenerRow(stock(sparse), sparse, [], true, new Date('2026-10-31T12:00:00Z'));
  assert.equal(result.three?.startDate, '20260808');
  assert.equal(result.three?.startPrice, 100);
  assert.equal(result.three?.currentPrice, 120);
  assert.equal(result.three?.returnPct, 20);
  assert.equal(result.six, null, 'must never display an August price as the 180-day May baseline');
  assert.deepEqual(result.priceQuote, { closeRial: 120, sessionDate: 20261028 });
  assert.match(result.note, /پوشش سابقه قیمت/);
});

test('F2: 100-day history keeps 90-day metrics but suppresses the 180-day column', () => {
  const partial = sessions.slice(-72).map((d_even) => ({ d_even, close: 1000, last: 1000,
    high: 1010, low: 990, yesterday: 1000 }));
  const result = screen(partial);
  assert.equal(result.three?.returnPct, 0);
  assert.equal(result.six, null);
  assert.equal(result.status, 'warning');
  assert.match(result.note, /پوشش سابقه قیمت/);
});

test('F3: detected verified corporate action survives row serialization', () => {
  const candles = flat(1000, 400);
  const changes = [{ date: actionDate, oldShares: 100, newShares: 250 }];
  const effective = resolveAnalysisAdjustments(candles, changes).effective;
  assert.equal(detectGapActions(candles, effective, sessions[0]).length, 1);
  const result = screen(candles, changes);
  assert.equal(result.actions.length, 1);
  assert.deepEqual(result.actions[0], {
    kind: 'افزایش سرمایه', date: String(actionDate), before: 1000, after: 400,
    percent: 150, confirmed: true, oldShares: 100, newShares: 250,
  });
  assert.equal(result.six?.returnPct, 0);
  assert.equal(result.status, 'warning', 'confirmed corporate actions are exposed for audit');
});

test('F4: missing yesterday does not hide a 60% observed scale break', () => {
  const candles = flat(1000, 400);
  candles[actionIndex].yesterday = undefined;
  const resolved = resolveAnalysisAdjustments(candles, []);
  assert.deepEqual(resolved.unresolved, [actionDate]);
  const result = screen(candles);
  assert.equal(result.six, null, 'unsafe 180-day return must be blocked');
  assert.deepEqual(result.priceQuote, { closeRial: 400, sessionDate: sessions.at(-1) },
    'dated closing price remains visible independently of unsafe returns');
  assert.equal(result.three?.returnPct, 0, 'safe post-gap period remains available');
  assert.equal(result.status, 'warning');
  assert.match(result.note, /شکاف|تعدیل/);
  assert.ok(result.actions.some((action) => action.date === String(actionDate) && !action.confirmed));
});

test('F4: missing yesterday with ordinary continuous closes is not a corporate event', () => {
  const candles = flat(1000, 1000);
  candles[actionIndex].yesterday = undefined;
  assert.deepEqual(resolveAnalysisAdjustments(candles, []), { effective: [], unresolved: [] });
  assert.equal(screen(candles).status, 'ready');
});

test('F1/F4: an official share ratio can corroborate a missing reference without guessing', () => {
  const candles = flat(1000, 400);
  candles[actionIndex].yesterday = undefined;
  const changes = [{ date: actionDate, oldShares: 100, newShares: 250 }];
  assert.deepEqual(resolveAnalysisAdjustments(candles, changes).effective, changes);
  assert.equal(screen(candles, changes).six?.returnPct, 0);
});
