import assert from "node:assert/strict";
import test from "node:test";
let version = 0;
const routeModule = () => import(`../app/api/holder-increases/route.ts?test=${++version}`);
const request = (body) => new Request("http://localhost/api/holder-increases", { method: "POST", body: JSON.stringify(body) });
const change = (insCode) => ({ id: `person-${insCode}`, name: "شخص حقیقی", insList: [{ insCode, name: "نماد", firstDay: 100, secondDay: 150 }] });
const payload = (codes) => ({ dates: [20260906, 20260907], shareHoldersChanges: codes.map(change) });
const info = (symbol = "کسرام") => ({ instrumentInfo: { lVal18AFC: symbol, zTitad: 1000, flowTitle: "بورس", sector: { cSecVal: "54" } } });

test("scoped holder scans only look up metadata for requested symbols", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    calls.push(String(url));
    if (String(url).includes("GetShareHolderChanges")) return Response.json(payload(["A", "B"]));
    if (String(url).includes("zarvanfund")) return Response.json({ "كسرام": { InsCode: "A" } });
    if (String(url).endsWith("/A")) return Response.json(info());
    throw new Error(`Unexpected request ${url}`);
  });
  const { POST } = await routeModule();
  const response = await POST(request({ view: "rows", symbols: ["کسرام"] }));
  const data = await response.json();
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].ownershipPct, 15);
  assert.equal(data.rows[0].changeShares, 50);
  assert.equal(calls.some((url) => url.endsWith("/B")), false);
  assert.equal(data.nextCursor, null);
});

test("whole market scans paginate at twenty instruments and retain all rows", async (t) => {
  const codes = Array.from({ length: 25 }, (_, i) => String(i));
  let metadataCalls = 0;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).includes("GetShareHolderChanges")) return Response.json(payload(codes));
    metadataCalls++;
    return Response.json(info(`نماد${String.fromCharCode(1575 + Number(String(url).split("/").at(-1)))}ب`));
  });
  const { GET } = await routeModule();
  const first = await (await GET(new Request("http://localhost/api/holder-increases"))).json();
  assert.equal(metadataCalls, 20);
  assert.equal(first.rows.length, 20);
  assert.equal(first.nextCursor, 20);
  const second = await (await GET(new Request("http://localhost/api/holder-increases?cursor=20&sourceDate=20260907"))).json();
  assert.equal(second.rows.length, 5);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.rows, ...second.rows].map((row) => row.id)).size, 25);
});

test("malformed upstream and network failures return dated fallback without cacheable fake zeros", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("<html>unavailable</html>", { status: 200 }));
  const { GET, POST } = await routeModule();
  const response = await GET(new Request("http://localhost/api/holder-increases"));
  const data = await response.json();
  assert.equal(data.fallback, true);
  assert.equal(data.sourceDate, 20260907);
  assert.ok(response.headers.get("cache-control").includes("no-store"));
  const summary = await (await POST(request({ instruments: [{ symbol: "نمادناشناخته", insCode: "unknown" }] }))).json();
  assert.equal(summary.fallback, true);
  assert.equal(Object.hasOwn(summary.summaries, "نمادناشناخته"), false);
});

test("a failed later page reports an error instead of mixing a fallback snapshot", async (t) => {
  t.mock.method(globalThis, "fetch", async () => { throw new Error("network unavailable"); });
  const { GET } = await routeModule();
  const response = await GET(new Request("http://localhost/api/holder-increases?cursor=20"));
  assert.equal(response.status, 502);
  assert.ok((await response.json()).error);
});

test("invalid requests are rejected before any upstream access", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("must not fetch"); });
  const { POST } = await routeModule();
  for (const body of [{ view: "rows", symbols: [] }, { view: "rows", symbols: [null] }, { view: "rows", symbols: ["کسرام"], cursor: -1 }, null]) {
    assert.equal((await POST(request(body))).status, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('oversized identifiers, malformed continuation dates and mixed-invalid mappings are rejected before fetching', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('must not fetch'); });
  const { GET, POST } = await routeModule();
  for (const body of [
    { view: 'rows', symbols: ['کسرام', 'x'.repeat(100)] },
    { view: 'rows', symbols: ['کسرام'], sourceDate: 'not-a-date' },
    { instruments: [{ symbol: 'کسرام', insCode: 'A/1' }] },
    { instruments: [{ symbol: 'کسرام', insCode: 'A' }, { symbol: '', insCode: 'B' }] },
  ]) assert.equal((await POST(request(body))).status, 400);
  assert.equal((await GET(new Request('http://local/api/holder-increases?cursor=20&sourceDate=invalid'))).status, 400);
  assert.equal(fetch.mock.callCount(), 0);
});

test('first GET page accepts the optional empty sourceDate sent by the active UI', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => Response.json(String(url).includes('GetShareHolderChanges')
    ? payload(['A']) : info()));
  const { GET } = await routeModule();
  const response = await GET(new Request('http://local/api/holder-increases?cursor=0&sourceDate=&_=123'));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.fallback, false);
});
