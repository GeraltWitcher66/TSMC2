import test from 'node:test';
import assert from 'node:assert/strict';

let nonce = 0;
const route = () => import(`../app/api/holder-increases/route.ts?fallbackPage=${++nonce}`);
const get = (cursor, date, fallback = false) => new Request(
  `http://localhost/api/holder-increases?cursor=${cursor}&sourceDate=${date ?? ''}&fallback=${fallback}`,
);
const post = (body) => new Request('http://localhost/api/holder-increases', {
  method: 'POST', body: JSON.stringify(body),
});

test('bundled holder archive is paginated at 20, preserves provenance and requires explicit continuation mode', async (t) => {
  let officialCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { officialCalls++; return new Response('blocked', { status: 503 }); });
  const { GET } = await route();
  const first = await (await GET(get(0))).json();
  assert.equal(first.fallback, true);
  assert.equal(first.partial, true);
  assert.equal(first.sourceDate, 20260907);
  assert.equal(first.sourceCompleteness, 'earlier-session-subset');
  assert.equal(first.rows.length, 20);
  assert.equal(first.nextCursor, 20);
  const ids = [...first.rows.map((r) => r.id)];
  let cursor = first.nextCursor;
  do {
    const page = await (await GET(get(cursor, first.sourceDate, true))).json();
    assert.equal(page.fallback, true);
    assert.equal(page.sourceDate, first.sourceDate);
    assert.ok(page.rows.length <= 20);
    ids.push(...page.rows.map((r) => r.id));
    cursor = page.nextCursor;
  } while (cursor !== null);
  assert.equal(ids.length, 77);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(officialCalls, 2, 'an explicit bundled continuation must not re-contact official mirrors');
  assert.equal((await GET(get(20, 20261021, true))).status, 409, 'archive and live pages cannot be mixed');
});

test('scoped archive pages filter before pagination and never claim complete live-session coverage', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('offline', { status: 503 }));
  const { POST } = await route();
  const first = await (await POST(post({ view: 'rows', symbols: ['کسرام', 'خودرو', 'فولاد'], cursor: 0 }))).json();
  assert.equal(first.fallback, true);
  assert.equal(first.partial, true);
  assert.equal(first.sourceCompleteness, 'earlier-session-subset');
  assert.ok(first.rows.every((r) => ['کسرام', 'خودرو', 'فولاد'].includes(r.symbol)));
  assert.ok(first.rows.length <= 20);
  if (first.nextCursor !== null) {
    const second = await (await POST(post({ view: 'rows', symbols: ['کسرام', 'خودرو', 'فولاد'], cursor: first.nextCursor, sourceDate: first.sourceDate, fallback: true }))).json();
    assert.equal(second.fallback, true);
    assert.ok(second.rows.length <= 20);
  }
});

test('old official source with final slots is not labelled complete for the expected current session', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('GetShareHolderChanges')) return Response.json({
      dates: [20260906, 20260907],
      shareHoldersChanges: [{ id: 'human-1', name: 'شخص حقیقی', insList: [{
        insCode: 'A', name: 'کسرام', firstDay: 100, secondDay: 150,
      }] }],
    });
    return Response.json({ instrumentInfo: { insCode: 'A', lVal18AFC: 'کسرام', flowTitle: 'بورس', zTitad: 1000 } });
  });
  const { GET, POST } = await route();
  const rows = await (await GET(get(0))).json();
  assert.equal(rows.fallback, false);
  assert.equal(rows.partial, true);
  assert.equal(rows.sourceCompleteness, 'earlier-session-subset');
  const summary = await (await POST(post({ instruments: [
    { symbol: 'کسرام', insCode: 'A' }, { symbol: 'نمادغایب', insCode: 'B' },
  ] }))).json();
  assert.equal(summary.fallback, false);
  assert.equal(summary.partial, true);
  assert.equal(summary.sourceCompleteness, 'earlier-session-subset');
  assert.equal(Object.hasOwn(summary.summaries, 'نمادغایب'), false);
});
