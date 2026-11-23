import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOfficialHolderChanges, validateHolderChangesPayload } from '../app/lib/holder-increases-source.ts';
import { createBrowserMarketClient } from '../app/lib/browser-market.ts';
import { fetchTsetmcViaHosts } from '../app/api/tsetmc-relay/route.ts';

const malformed = { dates: [20261013, 20261014], shareHoldersChanges: [
  { name: 'شخص حقیقی', insList: [] },
] };
const valid = { dates: [20261013, 20261014], shareHoldersChanges: [
  { id: 'holder-1', name: 'شخص حقیقی', insList: [
    { insCode: '12345', name: 'کسرام', firstDay: 100, secondDay: 150 },
  ] },
] };
const info = { instrumentInfo: { insCode: '12345', lVal18AFC: 'کسرام', flowTitle: 'بورس', zTitad: 1000 } };

test('official source rejects a dated HTTP 200 shell without a usable instrument and consults the other official mirror', async () => {
  assert.equal(validateHolderChangesPayload(malformed), false);
  const hosts = [];
  const result = await fetchOfficialHolderChanges({ request: async (url) => {
    hosts.push(new URL(url).hostname);
    return Response.json(String(url).includes('cdn.tsetmc.com') ? malformed : valid);
  } });
  assert.deepEqual(hosts, ['cdn.tsetmc.com', 'tsetmc.com']);
  assert.equal(result.sourceHost, 'tsetmc.com');
  assert.equal(result.sourceDate, 20261014);
});

test('summary endpoint never declares verified zeros from a date-labelled but unusable official shell', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => Response.json(malformed));
  const { POST } = await import(`../app/api/holder-increases/route.ts?malformed=${Date.now()}`);
  const request = new Request('http://local/api/holder-increases', {
    method: 'POST', body: JSON.stringify({ instruments: [{ symbol: 'نمادناموجودآزمایشی', insCode: '12345' }] }),
  });
  const response = await POST(request);
  const result = await response.json();
  assert.equal(result.fallback, true);
  assert.equal(Object.hasOwn(result.summaries, 'نمادناموجودآزمایشی'), false);
});

test('TSETMC relay skips malformed dated holder shells and uses the healthy mirror', async () => {
  const hosts = [];
  const response = await fetchTsetmcViaHosts('Shareholder/GetShareHolderChanges/false', undefined, undefined, async (url) => {
    hosts.push(new URL(url).hostname);
    return Response.json(String(url).includes('cdn.tsetmc.com') ? malformed : valid);
  });
  assert.deepEqual(hosts, ['cdn.tsetmc.com', 'tsetmc.com']);
  assert.deepEqual(JSON.parse(response), valid);
});

test('direct browser path tries relay on structurally invalid HTTP 200 shareholder changes', async () => {
  const calls = [];
  const client = createBrowserMarketClient(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.startsWith('/api/tsetmc-relay?')) return Response.json(valid);
    if (path.includes('GetShareHolderChanges')) return Response.json(malformed);
    if (path.includes('zarvanfund.ir')) return Response.json({ 'کسرام': { InsCode: '12345' } });
    if (path.includes('GetInstrumentInfo/')) return Response.json(info);
    throw new Error('unexpected: ' + path);
  });
  const result = await client.holders(['کسرام']);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].changeShares, 50);
  assert.ok(calls.some((path) => path.startsWith('/api/tsetmc-relay?')));
});

test('direct browser metadata lookup can recover through relay after a malformed HTTP 200', async () => {
  const calls = [];
  const client = createBrowserMarketClient(async (url) => {
    const path = String(url);
    calls.push(path);
    if (path.startsWith('/api/tsetmc-relay?')) return Response.json(info);
    if (path.includes('GetShareHolderChanges')) return Response.json(valid);
    if (path.includes('zarvanfund.ir')) return Response.json({ 'کسرام': { InsCode: '12345' } });
    if (path.includes('GetInstrumentInfo/')) return Response.json({ instrumentInfo: {} });
    throw new Error('unexpected: ' + path);
  });
  const result = await client.holders(['کسرام']);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].market, 'بورس');
  assert.ok(calls.some((path) => path.startsWith('/api/tsetmc-relay?') && path.includes('GetInstrumentInfo')));
});
