import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { defaultSymbols } from "../app/default-symbols.ts";

const base = process.env.QA_BASE_URL || "https://iran-stock-screener.ar-nikzad09.workers.dev";
const results = [];
async function api(path, body) {
  const started = Date.now();
  const send = () => fetch(`${base}${path}`, { method: body ? "POST" : "GET", headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(125000) });
  const response = await send().catch(async (error) => {
    console.log(JSON.stringify({ path, transportRetry: error.message }));
    return send();
  });
  const raw = await response.text();
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`${path}: HTTP ${response.status}: ${raw.slice(0, 180)}`); }
  const result = { path, http: response.status, elapsedMs: Date.now() - started, requested: body?.symbols?.length, rows: data.rows?.length, latestDate: data.latestDate ?? data.sourceDate, fallback: data.fallback ?? false, partial: data.partial ?? false, errors: data.rows?.filter((row) => row.status === "error").length, error: data.error };
  results.push(result);
  console.log(JSON.stringify(result));
  assert.equal(response.status, 200, JSON.stringify(result));
  return data;
}
await api("/api/screener", { symbols: defaultSymbols.slice(0, 20) });
await api("/api/market-highlights", { symbols: ["کسرام", "کفپارس"] });
await api("/api/holder-increases", { view: "rows", symbols: ["کسرام", "کفپارس"] });
await api("/api/holder-increases");

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_URL || "playwright");
const browser = await chromium.launch({ headless: true, channel: "msedge" });
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addInitScript(() => {
    localStorage.setItem("ss-custom-v1", JSON.stringify(["کسرام", "کفپارس"]));
    localStorage.setItem("ss-active-source-v1", "custom");
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const initial = page.waitForResponse((response) => response.url().includes("/api/screener"), { timeout: 130000 });
  await page.goto(base);
  await page.getByRole("button", { name: "ورود به برنامه", exact: true }).click();
  assert.equal((await initial).status(), 200);
  await page.getByRole("cell").filter({ hasText: "کسرام" }).first().waitFor();
  await page.getByRole("button", { name: /بیشترین‌های فهرست/ }).click();
  const ranking = page.waitForResponse((response) => response.url().includes("/api/market-highlights") && response.request().postDataJSON().symbols.length === 2, { timeout: 130000 });
  const holder = page.waitForResponse((response) => response.url().includes("/api/holder-increases") && response.request().method() === "POST" && response.request().postDataJSON()?.view === "rows" && response.request().postDataJSON()?.symbols?.length === 2, { timeout: 130000 });
  await page.getByRole("group", { name: "محدوده اسکن بیشترین‌ها" }).getByRole("button", { name: "اسکن دلخواه (۲)", exact: true }).click();
  assert.equal((await ranking).status(), 200);
  assert.equal((await holder).status(), 200);
  await page.getByRole("table", { name: "بیشترین ارزش معاملات", exact: true }).locator("tbody tr").first().waitFor();
  assert.equal(await page.locator(".highlight-card").count(), 5);
  assert.equal(await page.getByRole("group", { name: "محدوده اسکن بیشترین‌ها" }).getByRole("button").count(), 4);
  await page.waitForFunction(() => {
    const status = document.querySelector(".holder-highlight-status")?.textContent || "";
    return status.includes("تاریخ تغییرات") && !status.includes("در حال دریافت") && !status.includes("پشتیبان") && !status.includes("—");
  }, undefined, { timeout: 90000 });
  const holderDate = await page.locator(".holder-highlight-status").innerText();
  assert.deepEqual(errors, []);
  await mkdir("work/qa", { recursive: true });
  await page.screenshot({ path: "work/qa/production-desktop.png", fullPage: true });
  results.push({ browser: "PASS", cards: 5, shareholderDate: holderDate, pageErrors: errors });
  await writeFile("work/qa/production-result.json", JSON.stringify({ checkedAt: new Date().toISOString(), base, results }, null, 2));
  console.log("PASS: production APIs and real browser hydration, price rows, scoped ranking, five cards.");
} finally { await browser.close(); }
