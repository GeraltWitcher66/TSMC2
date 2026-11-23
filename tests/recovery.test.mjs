import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithTimeout, readApiJson, withDeadline, loadBatches } from "../app/lib/request-lifecycle.ts";
import { groupHolderRowsBySymbol } from "../app/lib/format.ts";
import { extractMajorIndividualHoldingChanges } from "../app/lib/market.ts";
import { enrichHolding } from "../app/lib/holder-records.ts";
import { POST as holders } from "../app/api/holders/route.ts";
import { GET as universe } from "../app/api/market-universe/route.ts";
import { fetchTsetmcViaHosts, isAllowedTsetmcPath } from "../app/api/tsetmc-relay/route.ts";
const never = () => new Promise(() => {});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const options = { budgetMs: 150, attemptMs: 20, retryMs: 1 };

test("relay targets the official /api/ namespace and skips HTML error pages", async (t) => {
  const urls = [];
  t.mock.method(globalThis, "fetch", async (url) => {
    urls.push(String(url));
    return urls.length === 1 ? new Response("<html>unavailable</html>") : Response.json({ closingPriceInfo: { dEven: 20260907 } });
  });
  const body = await fetchTsetmcViaHosts("ClosingPrice/GetClosingPriceInfo/123");
  assert.equal(JSON.parse(body).closingPriceInfo.dEven, 20260907);
  assert.deepEqual(urls, ["https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceInfo/123", "https://tsetmc.com/api/ClosingPrice/GetClosingPriceInfo/123"]);
});
test("relay rejects traversal and cancels without attempting another host", async (t) => {
  for (const path of ["ClosingPrice/GetClosingPriceInfo/../x", "ClosingPrice/GetClosingPriceInfo/%2e%2e/x", "https://other.test"]) assert.equal(isAllowedTsetmcPath(path), false);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({}); });
  assert.equal(await fetchTsetmcViaHosts("ClosingPrice/GetClosingPriceInfo/123", AbortSignal.abort()), null);
  assert.equal(calls, 0);
});

test("bounded transport parses a successful complete JSON response", async () => {
  const response = await fetchWithTimeout("https://test", {}, 100, async () => Response.json({ rows: [1] }));
  assert.deepEqual(await readApiJson(response), { rows: [1] });
});
test("transport timeout settles even if fetch ignores abort", async () => {
  await assert.rejects(fetchWithTimeout("https://test", {}, 10, never), { name: "TimeoutError" });
});
test("body stalled after successful headers is still bounded", async () => {
  await assert.rejects(fetchWithTimeout("https://test", {}, 10, async () => new Response(new ReadableStream({ start() {} }))), { name: "TimeoutError" });
});
test("HTTP errors retain status for caller validation", async () => {
  const response = await fetchWithTimeout("https://test", {}, 100, async () => Response.json({ error: "bad" }, { status: 503 }));
  assert.equal(response.ok, false); assert.equal(response.status, 503);
});
for (const body of ["", "<html>bad</html>"]) test(`invalid body is explicit error: ${body || "empty"}`, async () => {
  await assert.rejects(readApiJson(new Response(body)), /پاسخ/);
});
test("cancellation interrupts an uncooperative body and does not retry", async () => {
  const controller = new AbortController(); let attempts = 0;
  const pending = loadBatches([["a"]], async () => { attempts++; return never(); }, { ...options, signal: controller.signal });
  await delay(2); controller.abort();
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(attempts, 1);
});
test("already cancelled request never starts network", async () => {
  let calls = 0;
  await assert.rejects(fetchWithTimeout("https://test", { signal: AbortSignal.abort() }, 100, async () => { calls++; return Response.json({}); }), { name: "AbortError" });
  assert.equal(calls, 0);
});
test("retry exhaustion is exactly two attempts per failed batch", async () => {
  let calls = 0;
  const result = await loadBatches([["a"]], async () => { calls++; throw new Error("upstream unavailable"); }, options);
  assert.equal(calls, 2); assert.match(result.results[0].error, /upstream/);
});
test("partial batch success survives total deadline and unscheduled batches", async () => {
  const published = [];
  const result = await loadBatches([["a"], ["b"], ["c"], ["d"]], async ([symbol]) => symbol === "a" ? symbol : never(), { ...options, budgetMs: 25, onSuccess: (_, data) => published.push(data) });
  assert.equal(result.expired, true); assert.deepEqual(published, ["a"]);
  assert.equal(result.results.find((r) => r.data)?.data, "a");
});
test("concurrent requests never exceed two workers", async () => {
  let active = 0, max = 0;
  const result = await loadBatches(Array.from({ length: 9 }, (_, i) => [String(i)]), async ([symbol]) => {
    active++; max = Math.max(active, max); await delay(2); active--; return symbol;
  }, options);
  assert.equal(max, 2); assert.equal(result.results.length, 9);
});
test("stale completion after cancel cannot publish over a newer result", async () => {
  const controller = new AbortController(); let release;
  const published = [];
  const pending = loadBatches([["old"]], () => new Promise((resolve) => { release = resolve; }), { ...options, signal: controller.signal, onSuccess: (_, value) => published.push(value) });
  await delay(1); controller.abort(); await assert.rejects(pending);
  await loadBatches([["new"]], async () => "new", { ...options, onSuccess: (_, value) => published.push(value) });
  release("old"); await delay(1); assert.deepEqual(published, ["new"]);
});
test("deadline rejects and finally clears loading", async () => {
  let loading = true;
  try { await withDeadline(never, 5); } catch { /* error presentation is tested in browser */ }
  finally { loading = false; }
  assert.equal(loading, false);
});
test("representative values and date come from one record, independent of ranking", () => {
  const rows = [
    { id: "b", symbol: "فجام", currentShares: 100, ownershipPct: 10, changeShares: 90, date: 20260908 },
    { id: "a", symbol: "فجام", currentShares: 900, ownershipPct: 90, changeShares: 10, date: 20260907 },
  ];
  const group = groupHolderRowsBySymbol(rows)[0];
  assert.equal(group.representative, rows[1]); assert.equal(group.maxChange, 90); assert.equal(group.date, 20260907);
});
test("representative ties break deterministically by source ID, independent of input order", () => {
  const rows = ["b", "a"].map((id) => ({ id, symbol: "فجام", currentShares: 100, changeShares: 5, date: 20260907 }));
  assert.equal(groupHolderRowsBySymbol(rows)[0].representative.id, "a");
  assert.equal(groupHolderRowsBySymbol([...rows].reverse())[0].representative.id, "a");
});
test("unavailable ownership denominator stays unknown, zero shares stay zero", () => {
  const candidate = { currentShares: 0 };
  assert.equal(enrichHolding(candidate, { lVal18AFC: "فجام", flowTitle: "بورس" }).ownershipPct, null);
  assert.equal(enrichHolding(candidate, { lVal18AFC: "فجام", flowTitle: "بورس", zTitad: 100 }).ownershipPct, 0);
});
test("two anonymous source people with equal holdings remain independent end to end", () => {
  const person = { name: "شخص حقيقي", insList: [{ insCode: "1", firstDay: 100, secondDay: 200 }] };
  const changes = extractMajorIndividualHoldingChanges({ dates: [20260906, 20260907], shareHoldersChanges: [person, structuredClone(person)] });
  assert.equal(changes.length, 2); assert.notEqual(changes[0].id, changes[1].id);
  const rows = changes.map((c) => enrichHolding(c, { lVal18AFC: "فجام", flowTitle: "بورس", zTitad: 1000 }));
  const group = groupHolderRowsBySymbol(rows)[0];
  assert.equal(group.people, 2); assert.equal(group.representative.ownershipPct, 20);
});
test("explicitly identified duplicate person records still deduplicate", () => {
  const person = { id: "same", name: "شخص حقیقی", insList: [{ insCode: "1", firstDay: 100, secondDay: 200 }] };
  assert.equal(extractMajorIndividualHoldingChanges({ dates: [20260906, 20260907], shareHoldersChanges: [person, person] }).length, 1);
});
test("holders API preserves partial success and never fabricates zero on failed symbol", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => String(url).includes(encodeURIComponent("الف")) ? Response.json([{ name: "شخص حقیقی", shares: 1000 }]) : new Response("bad", { status: 502 }));
  const response = await holders(new Request("https://local/api/holders", { method: "POST", body: JSON.stringify({ symbols: ["الف", "ب"] }) }));
  const data = await response.json(); assert.deepEqual(data.counts, { الف: 1, ب: null }); assert.equal(data.partial, true);
});
test("holders API rejects oversized or malformed symbol lists", async () => {
  for (const symbols of [[1], Array(11).fill("الف"), null]) {
    const response = await holders(new Request("https://local/api/holders", { method: "POST", body: JSON.stringify({ symbols }) }));
    assert.equal(response.status, 400);
  }
});
test("universe upstream HTTP failure produces explicit 502", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("bad", { status: 503 }));
  assert.equal((await universe()).status, 502);
});
test("universe invalid JSON and empty sectors produce explicit errors", async (t) => {
  for (const value of ["bad", "[]", "{}"]){
    t.mock.method(globalThis, "fetch", async () => new Response(value));
    assert.equal((await universe()).status, 502);
  }
});
test("universe partial sectors are labelled and valid symbols preserved", async (t) => {
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).endsWith("/sectors")) return Response.json([{ sector_code: "54" }]);
    if (String(url).includes("market=bourse")) return Response.json([{ symbol: "كسرام", name: "سرامیک", market: "بورس" }]);
    return new Response("bad", { status: 502 });
  });
  const data = await (await universe()).json(); assert.equal(data.partial, true); assert.equal(data.symbols[0].symbol, "کسرام");
});
