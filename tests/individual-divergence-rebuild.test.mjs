import test from 'node:test';
import assert from 'node:assert/strict';
import { countMajorIndividualHolders } from '../app/lib/major-individual-count.ts';
import { analyzeDivergence, classifyDailyDivergence } from '../app/lib/divergence.ts';
import { POST as scanMajorHolders } from '../app/api/holders/route.ts';

test('different anonymous major people remain separate; only a stable person ID deduplicates', () => {
  const rows = [
    { name: 'شخص حقیقی', shares: 300 },
    { name: 'شخص حقيقي', shares: 300 },
    { name: 'شخص حقیقی', shares: 100, shareholderId: 'holder-a' },
    { name: 'شخص حقیقی', shares: 100, shareholderId: 'holder-a' },
    { name: 'شخص حقیقی', shares: 50, shareholderId: 'holder-b' },
    { name: 'شركت حقوقی', shares: 100000 },
  ];
  assert.deepEqual(countMajorIndividualHolders(rows), { count: 4, status: 'verified', sourceDate: null });
  assert.deepEqual(countMajorIndividualHolders([{ name: 'صندوق سرمایه گذاری', shares: 200 }]), { count: 0, status: 'verified-zero', sourceDate: null });
});

test('malformed or incomplete major-holder registers are unknown, never zero', () => {
  for (const value of [null, {}, [{ name: 'حقوقی' }], [{ shares: 100 }], [{ name: 'شخص حقیقی', shares: -1 }], [null]]) {
    assert.equal(countMajorIndividualHolders(value).count, null);
    assert.equal(countMajorIndividualHolders(value).status, 'invalid-source');
  }
});

const countRequest = () => new Request('http://localhost/api/holders', { method: 'POST', body: JSON.stringify({ symbols: ['کسرام'] }) });
test('whole-market API reports invalid source independently of verified zero', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json([{ name: 'شخص حقیقی', shares: 'invalid' }]));
  const response = await (await scanMajorHolders(countRequest())).json();
  assert.equal(response.counts['کسرام'], null);
  assert.equal(response.outcomes['کسرام'].status, 'invalid-source');
  assert.equal(response.partial, true);
});

test('whole-market API classifies timeout distinctly from general network failure', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => { throw new DOMException('timed out', 'TimeoutError'); });
  const timed = await (await scanMajorHolders(countRequest())).json();
  assert.equal(timed.outcomes['کسرام'].status, 'timeout');
  request.mock.restore();
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('network down'); });
  const failed = await (await scanMajorHolders(countRequest())).json();
  assert.equal(failed.outcomes['کسرام'].status, 'failed');
});

test('divergence direction classifies full-precision close versus last-trade RSI independently', () => {
  assert.equal(classifyDailyDivergence(200, 220, 45, 42), 'negative');
  assert.equal(classifyDailyDivergence(200, 180, 35, 38), 'positive');
  assert.equal(classifyDailyDivergence(200, 220, 45, 46), 'none');
  assert.equal(classifyDailyDivergence(200, 180, 45, 44), 'none');
  assert.equal(classifyDailyDivergence(200, 200, 45, 42), 'none');
  assert.equal(classifyDailyDivergence(200, 200.00001, 45.00004, 45.00003), 'negative');
  assert.equal(classifyDailyDivergence(200, Number.NaN, 45, 42), 'invalid');
});

test('closing-price RSI divergence is independent of a missing last-trade observation', () => {
  const candles = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return { d_even: Number(d.toISOString().slice(0, 10).replaceAll('-', '')), close: 100 + i, high: 101 + i, low: 99 + i, last: 100 + (i % 3), yesterday: 99 + i };
  });
  const options = { now: new Date('2026-02-08T10:00:00Z') };
  const input = candles.map((c, i) => i === 10 ? { ...c, last: undefined } : c);
  const result = analyzeDivergence(input, [], 90, options);
  assert.equal(result.status, 'none');
  assert.equal(result.divergence, null);
  assert.equal(typeof result.rsi, 'number');
  assert.equal(typeof result.divergenceRsi, 'number');
});

test('conflicting duplicate last-trade values cannot decide a divergence by insertion order', () => {
  const candles = Array.from({ length: 20 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 1 + i));
    return { d_even: Number(d.toISOString().slice(0, 10).replaceAll('-', '')), close: 100 + i, last: 100 + (i % 3), high: 101 + i, yesterday: 99 + i };
  });
  candles.push({ ...candles[19], last: 999 });
  assert.equal(analyzeDivergence(candles, [], 90, { now: new Date('2026-01-23T10:00:00Z') }).status, 'invalid');
});
