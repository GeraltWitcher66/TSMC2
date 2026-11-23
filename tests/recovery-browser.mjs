import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";
import { loadVerifiedHolderSnapshot } from "../app/data/holder-snapshot.ts";
import { groupHolderRowsBySymbol, compactSharesEn, signedSharesEn } from "../app/lib/format.ts";
import { calculatePeriod, marketHighlightFromInstrument } from "../app/lib/market.ts";

const output = process.env.QA_OUTPUT;
if (!output) throw new Error("QA_OUTPUT is required (evidence outside source tree)");
await mkdir(output, { recursive: true });
const before = process.env.QA_BEFORE === "1";
const snapshot = await loadVerifiedHolderSnapshot();
const wanted = ["فجام", "کسرا", "کسرام", "خکاوه", "فنر", "ممسنی", "غگل", "لکما"];
const actual = snapshot.rows.filter((row) => wanted.includes(row.symbol));
const four = groupHolderRowsBySymbol(snapshot.rows).find((group) => group.people >= 4);
// Explicit synthetic case when the dated real snapshot has no four-person group.
const syntheticFour = Array.from({ length: 4 }, (_, i) => ({ ...actual[0], id: `synthetic-${i}`, symbol: "آزمون چهارنفره", instrumentName: "داده مصنوعی آزمون", currentShares: 1e6, changeShares: 100, ownershipPct: 1 }));
const rows = [...actual, ...(four && !wanted.includes(four.symbol) ? four.children : syntheticFour)];
const symbols = [...new Set(rows.map((row) => row.symbol))];
const history = [{ d_even: 20260907, close: 100, high: 120 }, { d_even: 20260801, close: 90, high: 140 }, { d_even: 20260601, close: 80, high: 110 }];
const screener = (symbol) => ({ symbol, insCode: symbol, status: "ready", actions: [], rsi: 40, realHolders: null, three: calculatePeriod(history, 90), six: calculatePeriod(history, 180) });
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const checks = [];
const errors = [];
const check = (name, value) => { assert.ok(value, name); checks.push(name); };
async function setup(viewport, mode = "success") {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 500 });
  await context.addInitScript(({ symbols }) => {
    localStorage.setItem("ss-haghighi-v1", JSON.stringify(symbols));
    localStorage.setItem("ss-custom-v1", JSON.stringify(["آزمایشی"]));
  }, { symbols });
  const calls = [];
  let failing = false;
  await context.route("**/api/**", async (route) => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const body = req.method() === "POST" ? req.postDataJSON() : {};
    calls.push({ path, body });
    if (!req.url().startsWith("http://127.0.0.1")) { await route.fulfill({ status: 502, body: "unavailable" }); return; }
    if (path === "/api/screener") {
      if (mode === "timeout") return;
      if (mode === "invalid" || failing) { await route.fulfill({ status: 502, body: "<html>unavailable</html>" }); return; }
      await route.fulfill({ json: { rows: body.symbols.map(screener), latestDate: 20260907, fetchedAt: "2026-09-07T10:00:00Z" } });
    } else if (path === "/api/holder-increases") {
      if (body.instruments) await route.fulfill({ json: { summaries: {}, sourceDate: snapshot.sourceDate } });
      else await route.fulfill({ json: { ...snapshot, rows: body.symbols ? rows.filter((r) => body.symbols.includes(r.symbol)) : rows, fallback: false, nextCursor: null } });
    } else if (path === "/api/market-highlights") {
      await route.fulfill({ json: { rows: body.symbols.map((symbol) => marketHighlightFromInstrument({ Symbol: symbol, Date: 20260907, PriceYesterday: 1000, PriceLast: 1020, PriceClose: 970, Volume: 1e7, Value: 1e10, PriceMin: 970, AllowedMin: 970 })), latestDate: 20260907 } });
    } else if (path === "/api/holders") {
      await route.fulfill({ json: { counts: Object.fromEntries(body.symbols.map((s) => [s, 2])) } });
    } else await route.fulfill({ json: {} });
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("Failed to load resource")) errors.push(message.text()); });
  if (mode === "timeout") await page.clock.install();
  await page.goto(process.env.QA_BASE_URL || "http://127.0.0.1:3100/");
  await page.waitForTimeout(1200);
  await page.getByRole("button", { name: "ورود به برنامه", exact: true }).click();
  await page.locator(".modal-backdrop").waitFor({ state: "detached", timeout: 8000 });
  return { context, page, calls, fail: () => { failing = true; } };
}

try {
  for (const [width, height] of [[1366, 768], [1920, 1080], [390, 844], [430, 932]]) {
    const { context, page, calls } = await setup({ width, height });
    await page.locator(".session-state").getByText(/۱۴۰۵/).waitFor();
    check(`initial ordinary load ${width}`, calls.some((c) => c.path === "/api/screener"));
    check(`no new automatic holder scan ${width}`, !calls.some((c) => c.path === "/api/holders" || (c.path === "/api/holder-increases" && !c.body.instruments)));
    await page.getByRole("button", { name: "خ خرید حقیقی عمده", exact: true }).click();
    await page.locator(".holder-group-row").first().waitFor();
    await page.screenshot({ path: `${output}/${before ? "before" : "after"}-holders-${width}x${height}.png`, fullPage: true });
    if (!before) {
      check(`all main groups collapsed ${width}`, await page.locator(".holder-child-row").count() === 0);
      for (const group of groupHolderRowsBySymbol(rows)) {
        const parent = page.locator(".holder-group-row").filter({ has: page.getByRole("button", { name: new RegExp(`^${group.symbol}`) }) });
        const cells = parent.locator("td");
        const text = (await cells.allInnerTexts()).slice(2);
        check(`${width} ${group.symbol} same-record shares`, (await cells.nth(2).innerText()).includes(compactSharesEn(group.representative.currentShares)));
        check(`${width} ${group.symbol} same-record change`, (await cells.nth(4).innerText()).includes(signedSharesEn(group.representative.changeShares)));
        check(`${width} ${group.symbol} same-record percent`, (await cells.nth(3).innerText()).includes(new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 }).format(group.representative.ownershipPct)));
        await parent.locator("button strong").click();
        check(`${width} ${group.symbol} symbol expands every person`, await page.locator(".holder-child-row").count() === group.people);
        check(`${width} ${group.symbol} seven aligned columns`, await page.locator(".holder-child-row").first().locator("td").count() === 7);
        for (const [index, child] of group.children.entries()) {
          check(`${width} ${group.symbol} child ${index} shares preserved`, (await page.locator(".holder-child-row").nth(index).locator("td").nth(2).innerText()).includes(compactSharesEn(child.currentShares)));
          check(`${width} ${group.symbol} child ${index} change preserved`, (await page.locator(".holder-child-row").nth(index).locator("td").nth(4).innerText()).includes(signedSharesEn(child.changeShares)));
        }
        check(`${width} ${group.symbol} stable parent`, JSON.stringify((await cells.allInnerTexts()).slice(2)) === JSON.stringify(text));
        if (width < 500) await parent.locator(".holder-people-inline").tap();
        else await parent.locator(".holder-people-inline").click();
        check(`${width} ${group.symbol} badge collapses`, await page.locator(".holder-child-row").count() === 0);
      }
      const button = page.locator(".holder-group-row button").first();
      await button.focus(); await page.keyboard.press("Enter");
      check(`keyboard expands ${width}`, await button.getAttribute("aria-expanded") === "true");
      await page.keyboard.press("Space");
      check(`keyboard collapses ${width}`, await button.getAttribute("aria-expanded") === "false");
    }
    await page.getByRole("button", { name: /بیشترین‌های فهرست/ }).click();
    await page.locator(".holder-group-head").first().waitFor();
    if (!before) {
      check(`card initially collapsed ${width}`, await page.locator(".holder-person-row").count() === 0);
      for (const group of groupHolderRowsBySymbol(rows)) {
        const parent = page.locator(".holder-group-head").filter({ has: page.getByRole("button", { name: new RegExp(`^${group.symbol}`) }) });
        check(`card populated ${group.symbol} ${width}`, (await parent.innerText()).includes(compactSharesEn(group.representative.currentShares)));
        await parent.locator(".holder-people-inline").click();
        check(`card badge expands ${group.symbol} ${width}`, await page.locator(".holder-person-row").count() === group.people);
        await parent.locator("button strong").click();
        check(`card symbol collapses ${group.symbol} ${width}`, await page.locator(".holder-person-row").count() === 0);
      }
      check(`reversal still four columns ${width}`, await page.locator(".reversal-table-head").locator(":scope > *").count() === 4);
      check(`copy-safe dates ${width}`, await page.locator(".row-date").first().evaluate((el) => getComputedStyle(el).userSelect) === "none");
      check(`RTL document ${width}`, await page.locator("html").getAttribute("dir") === "rtl");
      check(`no page overflow ${width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      check(`card numerical summary fits viewport ${width}`, await page.locator(".holder-groups").evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    }
    await page.locator(".holder-groups").evaluate((el) => { el.scrollTop = 0; });
    await page.screenshot({ path: `${output}/${before ? "before" : "after"}-cards-${width}x${height}.png`, fullPage: true });
    await context.close();
  }
  if (!before) {
    for (const mode of ["timeout", "invalid"]) {
      const { context, page, calls } = await setup({ width: 1366, height: 768 }, mode);
      if (mode === "timeout") { if (!calls.some((c) => c.path === "/api/screener")) await page.waitForRequest("**/api/screener**"); await page.clock.fastForward(55_001); await page.clock.fastForward(701); await page.clock.fastForward(65_000); }
      await page.getByRole("alert").waitFor();
      check(`${mode} terminal error`, (await page.locator(".session-state").innerText()).includes("دریافت داده ناموفق بود"));
      check(`${mode} bounded retries`, calls.filter((c) => c.path === "/api/screener").length <= 2);
      await page.screenshot({ path: `${output}/after-${mode}.png`, fullPage: true });
      await context.close();
    }
    const { context, page, fail } = await setup({ width: 1366, height: 768 });
    await page.locator(".session-state").getByText(/۱۴۰۵/).waitFor();
    const oldDate = await page.locator(".session-state").innerText();
    fail();
    await page.getByRole("button", { name: /بروزرسانی اطلاعات/ }).click();
    await page.getByRole("alert").waitFor();
    check("cached dated rows survive failed refresh", (await page.locator(".session-state").innerText()) === oldDate && await page.locator("tbody tr").count() > 0);
    await context.close();

    const healthy = await setup({ width: 1366, height: 768 });
    await healthy.page.locator(".session-state").getByText(/۱۴۰۵/).waitFor();
    await healthy.page.getByRole("button", { name: "اسکن حقیقی‌های حقیقی", exact: true }).click();
    await healthy.page.getByRole("status").filter({ hasText: /کامل شد/ }).waitFor();
    check("manual shareholder scan completes", healthy.calls.some((c) => c.path === "/api/holders") && !(await healthy.page.getByRole("button", { name: "توقف اسکن", exact: true }).count()));
    await healthy.page.getByRole("button", { name: /فیلتر ۱۸۰ روزه/ }).click();
    check("180 day view retains watchlist", await healthy.page.locator("tbody tr").count() === symbols.length);
    await healthy.page.getByRole("button", { name: /فیلتر ۹۰ روزه/ }).click();
    await healthy.page.locator(".star-button").first().click();
    await healthy.page.getByRole("button", { name: /نمادهای منتخب/ }).click();
    check("favorite persists and selected view works", await healthy.page.locator("tbody tr").count() === 1);
    await healthy.page.getByRole("button", { name: /فیلتر ۹۰ روزه/ }).click();
    let releaseOld;
    let oldStarted;
    const started = new Promise((resolve) => { oldStarted = resolve; });
    let first = true;
    await healthy.page.route("**/api/screener**", async (route) => {
      if (first) {
        first = false; oldStarted();
        await new Promise((resolve) => { releaseOld = resolve; });
        await route.fulfill({ json: { rows: [screener("پاسخ قدیمی")], latestDate: 20260907 } }).catch(() => {});
      } else await route.fulfill({ json: { rows: route.request().postDataJSON().symbols.map(screener), latestDate: 20260907 } });
    });
    await healthy.page.getByRole("button", { name: /بروزرسانی اطلاعات/ }).click();
    await started;
    await healthy.page.getByRole("button", { name: /مدیریت نماد حقیقی/ }).click();
    await healthy.page.getByRole("textbox", { name: "فهرست نمادها", exact: true }).fill("فجام\nفنر");
    await healthy.page.getByRole("button", { name: "ذخیره فهرست", exact: true }).click();
    await healthy.page.getByRole("button", { name: /بروزرسانی اطلاعات/ }).waitFor();
    releaseOld();
    check("watchlist edit supersedes in-flight request", await healthy.page.locator("tbody tr").count() === 2 && !(await healthy.page.locator("tbody").innerText()).includes("پاسخ قدیمی"));
    check("edited watchlist persists", (await healthy.page.evaluate(() => JSON.parse(localStorage.getItem("ss-haghighi-v1")))) .join(",") === "فجام,فنر");
    await healthy.context.close();
    check("no browser runtime errors", errors.length === 0);
  }
  await writeFile(`${output}/${before ? "before" : "after"}-browser-results.json`, JSON.stringify({ checks, errors, sourceDate: snapshot.sourceDate, symbols, groups: groupHolderRowsBySymbol(rows).map((g) => ({ symbol: g.symbol, people: g.people, representative: g.representative })) }, null, 2));
  console.log(`PASS ${checks.length} browser assertions; snapshot session ${snapshot.sourceDate}`);
} finally { await browser.close(); }
