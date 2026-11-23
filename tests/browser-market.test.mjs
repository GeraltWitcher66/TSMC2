import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserMarketClient } from "../app/lib/browser-market.ts";

const payload = { dates: [20260906, 20260907], shareHoldersChanges: [
  { id: "one", name: "شخص حقیقی", insList: [{ insCode: "A", firstDay: 100, secondDay: 150 }] },
  { id: "two", name: "شخص حقیقی", insList: [{ insCode: "A", firstDay: 100, secondDay: 200 }] },
  { id: "three", name: "شخص حقیقی", insList: [{ insCode: "A", firstDay: 100, secondDay: 90 }] },
  { id: "elsewhere", name: "شخص حقیقی", insList: [{ insCode: "B", firstDay: 100, secondDay: 160 }] },
] };
const info = (symbol) => ({ instrumentInfo: { lVal18AFC: symbol, zTitad: 1000, flowTitle: "بورس" } });

test("direct browser fallback preserves separate holders and only resolves the requested scope", async () => {
  const calls = [];
  const client = createBrowserMarketClient(async (url) => {
    calls.push(url);
    if (url.includes("GetShareHolderChanges")) return Response.json(payload);
    if (url.includes("zarvanfund")) return Response.json({ "كسرام": { InsCode: "A" } });
    if (url.endsWith("/A")) return Response.json(info("کسرام"));
    throw new Error(`Unexpected ${url}`);
  });
  const result = await client.holders(["کسرام"]);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].ownershipPct, 20);
  assert.equal(result.sourceDate, 20260907);
  assert.equal(result.fallback, false);
  assert.equal(calls.some((url) => url.endsWith("/B")), false);
  const summary = await client.summaries([{ symbol: "کسرام", insCode: "A" }]);
  assert.equal(summary.summaries["کسرام"].buyCount, 2);
  assert.equal(summary.summaries["کسرام"].sellCount, 1);
  assert.equal(calls.filter((url) => url.includes("GetShareHolderChanges")).length, 1);
});

test("direct scans report partial metadata and reject total metadata failure", async () => {
  const client = createBrowserMarketClient(async (url) => {
    if (url.includes("GetShareHolderChanges")) return Response.json(payload);
    if (url.endsWith("/A")) return Response.json(info("کسرام"));
    throw new Error("network error");
  });
  const partial = await client.holders();
  assert.equal(partial.partial, true);
  assert.equal(partial.rows.length, 2);
  const failed = createBrowserMarketClient(async (url) => url.includes("GetShareHolderChanges") ? Response.json(payload) : Promise.reject(new Error("network error")));
  await assert.rejects(failed.holders(), /مشخصات سهامداران/);
});

test("malformed and dateless direct responses never become an empty successful scan", async () => {
  for (const data of [{}, { dates: [20260907], shareHoldersChanges: [] }, { dates: [20260906, 20260907] }]) {
    const client = createBrowserMarketClient(async () => Response.json(data));
    await assert.rejects(client.holders(), /تاریخ یا ساختار/);
  }
  const empty = createBrowserMarketClient(async () => Response.json({ dates: [20260906, 20260907], shareHoldersChanges: [] }));
  await assert.rejects(empty.holders(), /تاریخ یا ساختار/, 'an empty official change feed cannot establish verified zeros');
});

test("a superseded direct scan stops before making more requests", async () => {
  let calls = 0;
  const client = createBrowserMarketClient(async () => { calls++; return Response.json(payload); });
  await assert.rejects(client.holders(undefined, () => false), /محدوده/);
  assert.equal(calls, 0);
});

test("a blocked browser network stops metadata fan-out after repeated failures", async () => {
  let metadataCalls = 0;
  const many = { dates: [20260906, 20260907], shareHoldersChanges: Array.from({ length: 30 }, (_, i) => ({ name: "شخص حقیقی", insList: [{ insCode: String(i), firstDay: 100, secondDay: 150 }] })) };
  const client = createBrowserMarketClient(async (url) => {
    if (url.includes("GetShareHolderChanges")) return Response.json(many);
    metadataCalls++;
    throw new Error("blocked network");
  });
  await assert.rejects(client.holders());
  assert.ok(metadataCalls <= 8, `Unexpected fan-out: ${metadataCalls}`);
});
