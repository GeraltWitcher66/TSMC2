import assert from "node:assert/strict";
import test from "node:test";
let version = 0;
const routeModule = () => import(`../app/api/holders/route.ts?test=${++version}`);
const request = (symbols) => new Request("http://localhost/api/holders", { method: "POST", body: JSON.stringify({ symbols }) });

const holder = (name, shares = 1_000_000) => ({ name, shares, percent: 1, change: 0, amount: 0 });

test("counts individual holders across Persian and Arabic spellings, spaces and zero-widths", async (t) => {
  const data = [
    holder("شخص حقیقی"),                      // Persian spelling + space
    holder("شخص حقيقي"),                      // Arabic ي
    holder("\u200cشخص حقیقی\u200f"),          // zero-width non-joiner + RLM
    holder("  شخص حقیقی  "),                  // leading/trailing spaces
    holder("شركت سرمايه گذاري ملي"),          // company — NOT counted
    holder("صندوق سرمايه گذاري افقم"),        // fund — NOT counted
    holder("بانك ملت"),                       // bank — NOT counted
    holder("موسسه حسابداری"),                 // institution — NOT counted
    holder("شخص حقیقی"),                      // duplicate row (counted: two identical holdings = two rows of the register)
  ];
  t.mock.method(globalThis, "fetch", async () => Response.json(data));
  const { POST } = await routeModule();
  const data2 = await (await POST(request(["کسرام"]))).json();
  // 5 rows normalize to "شخص حقیقی" (4 spelling variants + 1 duplicate row;
  // each upstream row is an independent register entry and is counted once).
  assert.equal(data2.counts["کسرام"], 5);
});

test("a failed upstream request returns null, never a fake zero", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("err", { status: 503 }));
  const { POST } = await routeModule();
  const data = await (await POST(request(["کسرام"]))).json();
  assert.equal(data.counts["کسرام"], null);
});

test("a malformed upstream body returns null, never a fake zero", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ unexpected: "shape" }));
  const { POST } = await routeModule();
  const data = await (await POST(request(["کسرام"]))).json();
  assert.equal(data.counts["کسرام"], null);
});

test("symbols with no individual holders count zero", async (t) => {
  const data = [holder("شركت فولاد"), holder("صندوق طلا")];
  t.mock.method(globalThis, "fetch", async () => Response.json(data));
  const { POST } = await routeModule();
  const data2 = await (await POST(request(["فولاد"]))).json();
  assert.equal(data2.counts["فولاد"], 0);
});

test("duplicate symbols in the request are scanned once", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json([holder("شخص حقیقی")]));
  const { POST } = await routeModule();
  const data = await (await POST(request(["کسرام", "کسرام", "کسرام"]))).json();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(data.counts["کسرام"], 1);
});

test("an empty request returns an empty count map", async () => {
  const { POST } = await routeModule();
  const data = await (await POST(request([]))).json();
  assert.deepEqual(data.counts, {});
});

test("malformed and oversized holder symbols fail before upstream access", async (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw Error("unexpected upstream access"); });
  const { POST } = await routeModule();
  for (const symbols of [["x".repeat(65)], ["123456"], ["کسرام", "x".repeat(100)]]) {
    assert.equal((await POST(request(symbols))).status, 400);
  }
  assert.equal(fetch.mock.callCount(), 0);
});
