import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverHighlightPrices } from '../app/lib/highlight-direct-recovery.ts';
import { highlightCoverage } from '../app/lib/data-coverage.ts';

const dated = (d = 20261014) => ({ d_even: d, open: 98, high: 106, low: 92, close: 103, last: 105, yesterday: 100, volume: 9000, value: 927000 });
const tickers = ['کسرام', 'فنر', 'فولاد'];
const mockProvider = ({ daily = Object.fromEntries(tickers.map(s => [s, [dated()]])),
  instruments = Object.fromEntries(tickers.map((s, i) => [s, { InsCode: String(i + 1), Name: `نام ${s}`, Date: 0 }])),
  failDaily = false, failInstruments = false } = {}) => {
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(String(url));
    const isDaily = String(url).includes('daily-batch');
    if ((isDaily && failDaily) || (!isDaily && failInstruments)) return new Response('<html>503</html>', { status: 503 });
    return Response.json(isDaily ? daily : instruments);
  };
  return { fetchMock, calls };
};

test('HTML 503 recovered in browser from dated provider without fabricating clientType or floor', async () => {
  const { fetchMock, calls } = mockProvider();
  const result = await recoverHighlightPrices(tickers, new AbortController().signal, fetchMock);
  assert.equal(result.rows.length, 3);
  assert.equal(result.partial, false);
  assert.equal(result.latestDate, 20261014);
  assert.equal(calls.length, 2);
  for (const row of result.rows) {
    assert.equal(row.sessionDate, 20261014);
    assert.equal(row.volume, 9000);
    assert.equal(row.value, 927000);
    assert.equal(row.clientTypeAvailable, false);
    assert.equal(row.netRealValue, null);
    assert.equal(row.floorVerified, false);
    assert.equal(row.realBuyValue, null);
  }
  const c = highlightCoverage(result.rows, 3);
  assert.equal(c.datedPrices, 3);
  assert.equal(c.clientType, 0);
  assert.equal(c.floor, 0);
});

test('partial response retains only real dated symbols and reports missing explicitly', async () => {
  const { fetchMock } = mockProvider({ daily: { 'کسرام': [dated()] } });
  const result = await recoverHighlightPrices(tickers, new AbortController().signal, fetchMock);
  assert.deepEqual(result.rows.map(row => row.symbol), ['کسرام']);
  assert.equal(result.partial, true);
  assert.equal(result.missingCount, 2);
});

test('invalid or future daily dates do not create false latest sessions', async () => {
  const { fetchMock } = mockProvider({ daily: { 'کسرام': [dated(20281014)] } });
  await assert.rejects(recoverHighlightPrices(['کسرام'], new AbortController().signal, fetchMock), /تاریخ‌دار معتبر/);
});

test('dated direct history survives upstream instruments 503, without inventing an insCode', async () => {
  const { fetchMock } = mockProvider({ failInstruments: true });
  const result = await recoverHighlightPrices(tickers, new AbortController().signal, fetchMock);
  assert.equal(result.rows.length, 3);
  assert.ok(result.rows.every(row => row.insCode === ''));
});

test('both upstream endpoints 503 produces a retryable failure rather than verified zero', async () => {
  const { fetchMock } = mockProvider({ failDaily: true, failInstruments: true });
  await assert.rejects(recoverHighlightPrices(['کسرام'], new AbortController().signal, fetchMock), /در دسترس نبود/);
});
test('browser direct recovery rejects zero-volume contradictory snapshot and selects valid daily on same date',async()=>{
 const traded=dated(20261024);
 const original={InsCode:'1',Date:20261024,PriceLast:105,PriceClose:103,PriceYesterday:100,PriceMin:110,PriceMax:120,Volume:0};
 const {fetchMock}=mockProvider({daily:{'کسرام':[traded]},instruments:{'کسرام':original}});
 const result=await recoverHighlightPrices(['کسرام'],new AbortController().signal,fetchMock);
 assert.equal(result.rows[0].quoteSource,'zarvan-daily');
 assert.equal(result.rows[0].volume,9000);
 assert.equal(result.rows[0].priceMin,92);
});
test('browser direct recovery cannot use two non-traded or contradictory candidates',async()=>{
 const original={InsCode:'1',Date:20261024,PriceLast:105,PriceClose:103,PriceYesterday:100,PriceMin:110,Volume:0};
 const {fetchMock}=mockProvider({daily:{'کسرام':[{...dated(20261024),high:90}]},instruments:{'کسرام':original}});
 await assert.rejects(recoverHighlightPrices(['کسرام'],new AbortController().signal,fetchMock),/تاریخ‌دار معتبر/);
});
test('browser direct recovery keeps a valid later traded snapshot when daily is older',async()=>{
 const original={InsCode:'1',Date:20261024,PriceLast:105,PriceClose:103,PriceYesterday:100,PriceMin:92,PriceMax:106,Volume:9000,Value:927000};
 const {fetchMock}=mockProvider({daily:{'کسرام':[dated(20261021)]},instruments:{'کسرام':original}});
 const result=await recoverHighlightPrices(['کسرام'],new AbortController().signal,fetchMock);
 assert.equal(result.rows[0].quoteSource,'zarvan-instruments');
 assert.equal(result.rows[0].sessionDate,20261024);
 assert.equal(result.rows[0].volume,9000);
});

test('no more than ten symbols per direct attempt; malformed response rejected', async () => {
  const { fetchMock } = mockProvider();
  await assert.rejects(recoverHighlightPrices(Array.from({length:11},(_,i)=>`نماد${i}`), new AbortController().signal, fetchMock), /نامعتبر/);
  const invalid = async () => Response.json([]);
  await assert.rejects(recoverHighlightPrices(['کسرام'], new AbortController().signal, invalid), /در دسترس نبود/);
});
