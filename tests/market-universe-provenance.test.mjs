import test from 'node:test';
import assert from 'node:assert/strict';

let nonce = 0;
const load = () => import(`../app/api/market-universe/route.ts?provenance=${++nonce}`);

test('market-universe retains the requested market when sector-symbol rows omit it', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url));
    if (path.pathname === '/api/sectors') return Response.json([{ sector_code: '01', sector_name: 'نمونه' }]);
    calls.push([path.searchParams.get('code'), path.searchParams.get('market')]);
    return Response.json(path.searchParams.get('market') === 'bourse'
      ? [{ symbol: 'فولاد', name: 'فولاد مبارکه' }]
      : [{ symbol: 'آریا', name: 'پلیمر آریاساسول' }]);
  });
  const { GET } = await load();
  const response = await GET(new Request('http://localhost/api/market-universe'));
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.partial, false);
  assert.deepEqual(calls, [['01', 'bourse'], ['01', 'farabourse']]);
  assert.equal(body.symbols.find((row) => row.symbol === 'فولاد')?.market, 'bourse');
  assert.equal(body.symbols.find((row) => row.symbol === 'آریا')?.market, 'farabourse');
  assert.ok(body.symbols.every((row) => row.marketProvenance === 'sector-request'));
});

test('market-universe identifies failed sector+market endpoints without asserting unknown symbol totals', async (t) => {
  const attempts = new Map();
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url));
    if (path.pathname === '/api/sectors') return Response.json([{ sector_code: '10' }, { sector_code: '20' }]);
    const id = `${path.searchParams.get('code')}:${path.searchParams.get('market')}`;
    attempts.set(id, (attempts.get(id) ?? 0) + 1);
    if (id === '10:farabourse') return new Response('upstream unavailable', { status: 503 });
    if (id === '20:bourse' && attempts.get(id) === 1) return new Response('transient', { status: 503 });
    return Response.json([{ symbol: id.replace(':', '_'), name: 'نمونه' }]);
  });
  const { GET } = await load();
  const body = await (await GET(new Request('http://localhost/api/market-universe'))).json();
  assert.equal(body.partial, true);
  assert.equal(body.diagnostics.failedCount, 1);
  assert.deepEqual(body.diagnostics.failures.map((row) => [row.sectorCode, row.market]), [['10', 'farabourse']]);
  assert.equal(body.diagnostics.failedByMarket.farabourse, 1);
  assert.equal(body.diagnostics.failedByMarket.bourse, 0);
  assert.equal(attempts.get('10:farabourse'), 2);
  assert.equal(attempts.get('20:bourse'), 2);
  assert.equal(attempts.get('10:bourse'), 1);
  assert.equal(attempts.get('20:farabourse'), 1);
  assert.equal(Object.hasOwn(body, 'expectedSymbolCount'), false);
  assert.equal(body.symbols.length, 3);
});

test('zero successfully resolved symbols still reports source failures for a recoverable retry', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url));
    if (path.pathname === '/api/sectors') return Response.json([{ sector_code: '42' }]);
    return new Response('bad gateway', { status: 502 });
  });
  const { GET } = await load();
  const response = await GET(new Request('http://localhost/api/market-universe'));
  const body = await response.json();
  assert.equal(response.status, 502);
  assert.equal(body.diagnostics.failedCount, 2);
  assert.deepEqual(body.diagnostics.failedBySector, { '42': 2 });
  assert.deepEqual(body.diagnostics.failedByMarket, { bourse: 1, farabourse: 1 });
  assert.equal(Object.hasOwn(body, 'expectedSymbolCount'), false);
});

test('conflicting market membership is exposed as ambiguous instead of arbitrarily selecting the last response', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(String(url));
    if (path.pathname === '/api/sectors') return Response.json([{ sector_code: '77' }]);
    return Response.json([{ symbol: 'مشترک', name: 'نمونه' }]);
  });
  const { GET } = await load();
  const body = await (await GET(new Request('http://localhost/api/market-universe'))).json();
  assert.equal(body.symbols.length, 1);
  assert.equal(body.symbols[0].market, '');
  assert.equal(body.symbols[0].marketProvenance, 'ambiguous');
  assert.equal(body.partial, true);
  assert.equal(body.diagnostics.conflictingMarketsCount, 1);
});
