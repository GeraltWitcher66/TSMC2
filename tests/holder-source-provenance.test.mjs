import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchOfficialHolderChanges, holderSourceAgeDays, validateHolderChangesPayload } from '../app/lib/holder-increases-source.ts';

let routeVersion = 0;
const route = () => import(`../app/api/holder-increases/route.ts?provenance=${++routeVersion}`);
const post = (body) => new Request('http://localhost/api/holder-increases', { method: 'POST', body: JSON.stringify(body) });
const changes = (date = 20261007, previous = 20261006) => ({ dates: [previous, date], shareHoldersChanges: [
  { id: 'human-A', name: 'شخص حقیقی', insList: [{ insCode: 'A', name: 'کسرام', firstDay: 100, secondDay: 150 }] },
] });
const instrumentInfo = { instrumentInfo: { insCode: 'A', lVal18AFC: 'کسرام', flowTitle: 'بورس', zTitad: 1000, sector: { cSecVal: '54' } } };

test('official changes require real nonfuture dates with a valid previous source slot', () => {
  assert.equal(validateHolderChangesPayload(changes()), true);
  assert.equal(validateHolderChangesPayload({ ...changes(), dates: [20260230, 20260301] }), false);
  assert.equal(validateHolderChangesPayload({ ...changes(), dates: [20261007, 20261007] }), false);
  assert.equal(validateHolderChangesPayload({ ...changes(), dates: [20261006, 29990101] }), false);
  assert.equal(validateHolderChangesPayload({ ...changes(), dates: [20261004, 20261005, 20261006, 20261007, 29990101] }), true);
  assert.equal(validateHolderChangesPayload({ ...changes(), shareHoldersChanges: [] }), false, 'empty whole-market responses cannot establish zero changes');
});

test('malformed primary HTTP 200 cannot conceal healthy official alternative', async () => {
  const hosts = [];
  const result = await fetchOfficialHolderChanges({ request: async (url) => {
    hosts.push(new URL(url).hostname);
    return String(url).includes('cdn.tsetmc.com') ? Response.json({ error: 'not data' }) : Response.json(changes());
  } });
  assert.deepEqual(hosts, ['cdn.tsetmc.com', 'tsetmc.com']);
  assert.equal(result.sourceHost, 'tsetmc.com');
  assert.equal(result.sourceDate, 20261007);
});

test('a dated but weeks-old first host is compared with the other official host', async () => {
  const hosts = [];
  const result = await fetchOfficialHolderChanges({ request: async (url) => {
    const host = new URL(url).hostname;
    hosts.push(host);
    return Response.json(host === 'cdn.tsetmc.com' ? changes(20260907, 20260906) : changes(20261007, 20261006));
  } });
  assert.deepEqual(hosts, ['cdn.tsetmc.com', 'tsetmc.com']);
  assert.equal(result.sourceDate, 20261007);
  assert.equal(result.sourceHost, 'tsetmc.com');
  assert.ok(holderSourceAgeDays(result.sourceDate) >= 0);
});

test('server returns official dated rows through secondary host and independent instrument metadata recovery', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const uri = String(url); calls.push(uri);
    if (uri.includes('GetShareHolderChanges')) return uri.includes('cdn.tsetmc.com') ? new Response('blocked', { status: 403 }) : Response.json(changes());
    if (uri.includes('zarvanfund.ir')) return Response.json({ 'كسرام': { InsCode: 'A' } });
    if (uri.includes('GetInstrumentInfo')) return uri.includes('cdn.tsetmc.com') ? new Response('blocked', { status: 403 }) : Response.json(instrumentInfo);
    throw Error('unexpected fetch');
  });
  const { POST } = await route();
  const response = await POST(post({ view: 'rows', symbols: ['کسرام'] }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.fallback, false);
  assert.equal(data.delivery, 'source');
  assert.equal(data.sourceDate, 20261007);
  assert.equal(data.provenance.host, 'tsetmc.com');
  assert.equal(data.provenance.sourceDate, data.sourceDate);
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].changeShares, 50);
  assert.equal(data.rows[0].date, 20261007);
  assert.equal(data.partial, holderSourceAgeDays(20261007) > 7);
  assert.equal(data.provenance.currentSessionConfirmed, false);
  if (data.partial) assert.match(data.warning, /تاریخ داده رسمی/);
  assert.ok(calls.some((uri) => uri.includes('tsetmc.com/api/Instrument/GetInstrumentInfo/A')));
});

test('metadata outage does not turn a successfully received official dataset into an older bundled snapshot', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('GetShareHolderChanges')) return Response.json(changes());
    return new Response('unavailable', { status: 503 });
  });
  const { POST } = await route();
  const response = await POST(post({ view: 'rows', symbols: ['کسرام'] }));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.fallback, false);
  assert.equal(data.partial, true);
  assert.equal(data.sourceDate, 20261007);
  assert.equal(data.provenance.kind, 'official');
  assert.equal(data.rows.length, 0);
  assert.match(data.warning, /نبود ردیف به معنای نبود خرید نیست/);
});

test('old official source keeps explicit positive changes but never invents zero for an unlisted symbol', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => Response.json(
    String(url).includes('GetShareHolderChanges') ? changes(20260907, 20260906) : instrumentInfo,
  ));
  const { POST } = await route();
  const response = await POST(post({ instruments: [
    { symbol: 'کسرام', insCode: 'A' }, { symbol: 'ناموجود', insCode: 'none' },
  ] }));
  const result = await response.json();
  assert.equal(result.fallback, false);
  assert.equal(result.sourceDate, 20260907);
  assert.equal(result.partial, true);
  assert.equal(result.provenance.currentSessionConfirmed, false);
  assert.equal(result.summaries['کسرام'].buyShares, 50);
  assert.equal(Object.hasOwn(result.summaries, 'ناموجود'), false);
  assert.match(result.warning, /جلسه کنونی نیست/);
});

test('two failed official mirrors keep the embedded source date and historical provenance', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('blocked', { status: 403 }));
  const { GET } = await route();
  const response = await GET(new Request('http://localhost/api/holder-increases'));
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(data.fallback, true);
  assert.equal(data.delivery, 'bundled');
  assert.equal(data.sourceDate, 20260907);
  assert.equal(data.diagnostics.outcome, 'FALLBACK_BUNDLED');
  assert.equal(data.diagnostics.upstream.code, 'PROVIDER_HTTP_403');
  assert.equal(data.provenance, undefined);
});
