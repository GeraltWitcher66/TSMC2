import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverDatedScreenerBatch } from '../app/lib/screener-direct-recovery.ts';
import { loadBatches } from '../app/lib/request-lifecycle.ts';

const finalDay = new Date(Date.UTC(2026, 9, 14));
const days = Array.from({ length: 220 }, (_, i) => {
  const d = new Date(finalDay.getTime() - (219 - i) * 86400000);
  const compact = d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  return { d_even: compact, open: 100 + i, high: 115 + i, low: 90 + i, close: 100 + i, last: 100 + i, yesterday: 99 + i };
});

function providerRequest(history = { 'کسرام': days, 'فنر': days }) {
  const calls = [];
  const request = async (url) => {
    calls.push(String(url));
    return Response.json(String(url).includes('/daily-batch?') ? history : {
      'کسرام': { Name: 'پارس سرام', InsCode: '1001', EPS: 20, PE: 6, SectorPE: 8 },
      'فنر': { Name: 'پارس فنر', InsCode: '1002', EPS: 21, PE: 7, SectorPE: 9 },
    });
  };
  return { request, calls };
}

test('HTML 503 recovery keeps dated 90- and 180-day metrics for every valid stock', async () => {
  const source = providerRequest();
  const recovered = await recoverDatedScreenerBatch(['کسرام', 'فنر'], new AbortController().signal, source.request);
  assert.equal(recovered.rows.length, 2);
  assert.equal(recovered.latestDate, 20261014);
  for (const row of recovered.rows) {
    assert.equal(row.three.currentDate, '20261014');
    assert.ok(row.three.currentPrice > 0);
    assert.ok(row.six.currentPrice > 0);
    assert.ok(row.six.startPrice < row.three.startPrice);
    assert.equal(row.status, 'warning', 'direct historical fallback cannot claim an official fresh quote');
    assert.ok(row.analysisInput.candles.length >= 180);
  }
  assert.equal(source.calls.length, 2);
  assert.ok(source.calls.some((url) => url.includes('/daily-batch?limit=260')));
});

test('missing instrument history stays unavailable, never becomes zero or made-up data', async () => {
  const source = providerRequest({ 'کسرام': days });
  const result = await recoverDatedScreenerBatch(['کسرام', 'فنر'], new AbortController().signal, source.request);
  assert.equal(result.rows[0].three.currentDate, '20261014');
  assert.equal(result.rows[1].status, 'error');
  assert.equal(result.rows[1].three, null);
  assert.equal(result.rows[1].rsi, null);
});

test('invalid source history cannot be displayed as a completed screen', async () => {
  const source = providerRequest({ 'کسرام': [{ d_even: 0, close: 100, high: 120, low: 80 }] });
  await assert.rejects(recoverDatedScreenerBatch(['کسرام'], new AbortController().signal, source.request), /هیچ سابقه قیمت/);
});

test('a dated zero-volume slot cannot advance the last-trade date when Worker fails', async () => {
  const old = { d_even: 20261021, close: 679, high: 684, low: 674, volume: 1000 };
  const noTrade = { d_even: 20261024, close: 659, high: 664, low: 654, volume: 0 };
  const source = providerRequest({ 'کسرام': [noTrade, old] });
  const recovered = await recoverDatedScreenerBatch(['کسرام'], new AbortController().signal, source.request);
  assert.equal(recovered.latestDate, 20261021);
  assert.equal(recovered.rows[0].priceQuote.sessionDate, 20261021);
  assert.equal(recovered.rows[0].priceQuote.closeRial, 679);
});

test('a failed API batch can be recovered without dropping earlier valid batches', async () => {
  const source = providerRequest();
  const batches = [['کسرام'], ['فنر']];
  const seen = [];
  const result = await loadBatches(batches, async (batch, signal) => {
    if (batch[0] === 'کسرام') return { rows: [{ symbol: 'کسرام', three: { currentPrice: 100 } }] };
    return recoverDatedScreenerBatch(batch, signal, source.request);
  }, { concurrency: 1, budgetMs: 5000, pauseMs: 1, onSuccess: (_, data) => seen.push(...data.rows.map((r) => r.symbol)) });
  assert.equal(result.expired, false);
  assert.deepEqual(seen, ['کسرام', 'فنر']);
});
