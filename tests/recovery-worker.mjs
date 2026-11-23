import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";

const base = process.env.QA_WORKER_URL || "http://127.0.0.1:3105";
if (new URL(base).hostname !== "127.0.0.1") throw new Error("This smoke test targets a local Worker only.");
const results = [];
const home = await fetch(base, { signal: AbortSignal.timeout(10_000) });
assert.equal(home.status, 200);
const html = await home.text();
assert.match(html, /فیلتر بورس ایران/);
results.push({ route: "/", status: 200 });
const asset = html.match(/(?:src|href)="([^"]*ScreenerClient[^"]*\.js)"/)?.[1];
assert.ok(asset);
const script = await fetch(new URL(asset, base), { signal: AbortSignal.timeout(10_000) });
assert.equal(script.status, 200); assert.ok((await script.text()).length > 1000);
results.push({ route: asset, status: 200 });
for (const [path, init] of [
  ["/api/screener", { method: "POST", body: JSON.stringify({ symbols: [null] }) }],
  ["/api/market-highlights", { method: "POST", body: JSON.stringify({ symbols: [] }) }],
  ["/api/holders", { method: "POST", body: JSON.stringify({ symbols: [1] }) }],
  ["/api/holder-increases?cursor=-1", {}],
  ["/api/holder-increases", { method: "POST", body: "invalid JSON" }],
  ["/api/tsetmc-relay?path=not-allowed", {}],
]) {
  const response = await fetch(`${base}${path}`, { ...init, signal: AbortSignal.timeout(10_000) });
  assert.equal(response.status, 400, path);
  assert.ok((await response.json()).error, path);
  results.push({ route: path, status: response.status });
}
if (process.env.QA_OUTPUT) await writeFile(`${process.env.QA_OUTPUT}/worker-smoke.json`, JSON.stringify(results, null, 2));
console.log(`PASS ${results.length} real local Worker HTTP checks`);
