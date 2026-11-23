import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSymbol } from '../app/lib/market.ts';
import { createBrowserMarketClient } from '../app/lib/browser-market.ts';

let serial = 0;
const loadRoute = () => import(`../app/api/holder-increases/route.ts?pagination-recovery=${++serial}`);
const post = (symbols, cursor = 0, sourceDate = null) => new Request('http://local/api/holder-increases', {
  method: 'POST', body: JSON.stringify({ view: 'rows', symbols, cursor, sourceDate }),
});

function makeFixture(total = 178, positiveIndexes = [...Array(24).keys(), 110, 111, 112]) {
  const alphabet = [...'ابتثجخدذرزسشصضطظعغفقکگلمنوهی'];
  const suffix = (index) => index < alphabet.length ? alphabet[index] : `${alphabet[Math.floor(index / alphabet.length) - 1]}${alphabet[index % alphabet.length]}`;
  const symbols = Array.from({ length: total }, (_, i) => `نماد${suffix(i)}`);
  const codeBySymbol = new Map(symbols.map((symbol, i) => [symbol, String(i + 1000)]));
  const selected = positiveIndexes.map((i) => ({ symbol: symbols[i], code: codeBySymbol.get(symbols[i]) }));
  const changes = { dates: [20261013, 20261014], shareHoldersChanges: selected.map(({ code }) => ({
    id: `holder-${code}`, name: 'شخص حقیقی', insList: [{ insCode: code, name: 'شرکت رسمی با نام متفاوت از نماد', firstDay: 100, secondDay: 150 }],
  })) };
  return { symbols, codeBySymbol, selected, changes };
}

function fakeTransport(fixture, options = {}) {
  const calls = { zarvanSizes: [], officialInfo: [], shareholderChanges: 0 };
  const request = async (url) => {
    const uri = String(url);
    if (uri.includes('GetShareHolderChanges')) { calls.shareholderChanges++; return Response.json(fixture.changes); }
    if (uri.includes('zarvanfund.ir/api/instruments')) {
      const names = new URL(uri).searchParams.get('syms').split(',').map(normalizeSymbol);
      calls.zarvanSizes.push(names.length);
      if (options.failLookupFor?.(names)) return new Response('blocked', { status: 503 });
      const covered = names.length > 20 ? names.slice(0, 2) : names;
      return Response.json(Object.fromEntries(covered.filter((symbol) => fixture.codeBySymbol.has(symbol)).map((symbol) => [symbol, { InsCode: fixture.codeBySymbol.get(symbol) }])));
    }
    if (uri.includes('GetInstrumentInfo/')) {
      const code = uri.split('/').at(-1);
      calls.officialInfo.push(code);
      if (options.allowInfo?.(code)) {
        const symbol = [...fixture.codeBySymbol].find(([, value]) => value === code)?.[0];
        return Response.json({ instrumentInfo: { lVal18AFC: symbol, zTitad: 1000, flowTitle: 'بورس', insCode: code } });
      }
      return new Response('unavailable', { status: 503 });
    }
    throw Error(`unrecognized url ${uri}`);
  };
  return { request, calls };
}

test('scoped 178-symbol scans do not stop at 20 codes or lose verified buys when metadata fails', async (t) => {
  const f = makeFixture();
  const { request, calls } = fakeTransport(f, { allowInfo: (code) => code === '1000' || code === '1001' });
  t.mock.method(globalThis, 'fetch', request);
  const { POST } = await loadRoute();
  const batches = [f.symbols.slice(0, 100), f.symbols.slice(100)];
  const all = [];
  const perBatchPages = [];
  let returnedSourceDate = null;
  for (const symbols of batches) {
    let cursor = 0;
    let pages = 0;
    do {
      const response = await POST(post(symbols, cursor, returnedSourceDate));
      const page = await response.json();
      assert.equal(response.status, 200);
      assert.equal(page.sourceDate, 20261014);
      assert.equal(page.fallback, false);
      assert.equal(page.provenance.kind, 'official');
      assert.equal(page.partial, true);
      assert.equal(page.missingCount, 0, 'all 178 symbols should resolve in bounded lookup batches');
      assert.equal(page.pagePositiveRecords, page.rows.length, 'valid source-holder identities must not be erased by metadata failures');
      assert.equal(page.unresolvedRows, 0);
      assert.ok(page.rows.every((row) => row.date === page.sourceDate && row.changeShares === 50));
      returnedSourceDate = page.sourceDate;
      all.push(...page.rows);
      cursor = page.nextCursor;
      pages++;
    } while (cursor !== null);
    perBatchPages.push(pages);
  }
  assert.deepEqual(perBatchPages, [2, 1]);
  assert.equal(all.length, 27);
  assert.equal(new Set(all.map((row) => row.id)).size, 27);
  assert.equal(all.filter((row) => row.market === 'نامشخص').length, 25);
  assert.ok(all.filter((row) => row.market === 'نامشخص').every((row) => row.ownershipPct === null && row.ownership.status === 'unavailable'));
  assert.ok(calls.zarvanSizes.every((n) => n <= 20));
  assert.equal(calls.zarvanSizes.reduce((sum, n) => sum + n, 0), 178 * 1, 'each lookup batch is requested once');
});

test('one failed symbol-lookup batch does not erase other verified changes or break cursors', async (t) => {
  const f = makeFixture(45, [...Array(45).keys()]);
  const { request } = fakeTransport(f, { failLookupFor: (names) => names.includes(f.symbols[20]) });
  t.mock.method(globalThis, 'fetch', request);
  const { POST } = await loadRoute();
  const first = await (await POST(post(f.symbols))).json();
  assert.equal(first.sourcePositiveRecords, 45);
  assert.equal(first.scopedPositiveRecords, 25);
  assert.equal(first.lookupFailures, 1);
  assert.equal(first.missingCount, 20);
  assert.equal(first.partial, true);
  assert.equal(first.rows.length, 20);
  assert.equal(first.nextCursor, 20);
  const second = await (await POST(post(f.symbols, 20, first.sourceDate))).json();
  assert.equal(second.rows.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 25);
});

test('direct browser holder helper retains official signed changes on scoped metadata failure', async () => {
  const f = makeFixture(24, [0, 1, 21]);
  const { request, calls } = fakeTransport(f);
  const rows = await createBrowserMarketClient(request).holders(f.symbols);
  assert.equal(rows.sourceDate, 20261014);
  assert.equal(rows.partial, true);
  assert.equal(rows.fallback, false);
  assert.equal(rows.rows.length, 3);
  assert.ok(rows.rows.every((row) => row.market === 'نامشخص' && row.ownershipPct === null && row.changeShares === 50));
  assert.deepEqual(calls.zarvanSizes, [20, 4]);
});

test('a symbol with many individual buyers is paginated by rows, not by instrument codes', async (t) => {
  const changes = { dates: [20261013, 20261014], shareHoldersChanges: Array.from({ length: 45 }, (_, i) => ({
    id: `person-${i}`, name: 'شخص حقیقی', insList: [{ insCode: '12345', name: 'کسرام', firstDay: 100, secondDay: 200 + i }],
  })) };
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = String(url);
    if (path.includes('GetShareHolderChanges')) return Response.json(changes);
    if (path.includes('zarvanfund.ir/api/instruments')) return Response.json({ 'کسرام': { InsCode: '12345' } });
    if (path.includes('GetInstrumentInfo/12345')) return Response.json({ instrumentInfo: {
      insCode: '12345', lVal18AFC: 'کسرام', zTitad: 1000, flowTitle: 'بورس',
    } });
    throw Error(`unexpected ${path}`);
  });
  const { POST } = await loadRoute();
  const sizes = [], ids = [];
  let cursor = 0, date = null;
  do {
    const response = await POST(post(['کسرام'], cursor, date));
    assert.equal(response.status, 200);
    const page = await response.json();
    sizes.push(page.rows.length);
    ids.push(...page.rows.map((row) => row.id));
    date = page.sourceDate;
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.deepEqual(sizes, [20, 20, 5]);
  assert.equal(new Set(ids).size, 45);
});
