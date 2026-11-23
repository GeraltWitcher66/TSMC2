import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { calculatePeriod, marketHighlightFromInstrument } from "../app/lib/market.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE_URL || "playwright");
const browser = await chromium.launch({ headless: true, channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const requests = [];
const errors = [];
const highlightScans = [];
const holdingScans = [];
let failHoldings = false;
let enableDirect = false;
let slowHighlights = false;
let releaseHighlight;
const highlightGate = new Promise((resolve) => { releaseHighlight = resolve; });
const history = [
  { d_even: 20260907, close: 100, high: 100 },
  { d_even: 20260815, close: 100, high: 125 },
  { d_even: 20260720, close: 100, high: 200 },
  { d_even: 20260620, close: 100, high: 400 },
];
await context.addInitScript(() => {
  localStorage.setItem("ss-haghighi-v1", JSON.stringify(["کفپارس", "کسرام"]));
  localStorage.setItem("ss-zarbanana-v1", JSON.stringify(["سپیدار", "کسرام"]));
  localStorage.setItem("ss-custom-v1", JSON.stringify(["کسرام"]));
  localStorage.setItem("ss-active-source-v1", "custom");
});
await context.route("**/api/**", async (route) => {
  const request = route.request();
  const endpoint = new URL(request.url()).pathname;
  if (enableDirect && request.url().includes("cdn.tsetmc.com")) {
    if (endpoint.includes("GetShareHolderChanges")) {
      await route.fulfill({ json: { dates: [20260907, 20260908], shareHoldersChanges: [
        { id: "one", name: "شخص حقیقی", insList: [{ insCode: "K", firstDay: 17153703, secondDay: 18000000 }] },
        { id: "two", name: "شخص حقیقی", insList: [{ insCode: "K", firstDay: 12000000, secondDay: 13000000 }] },
      ] } });
    } else if (endpoint.includes("GetInstrumentInfo")) await route.fulfill({ json: { instrumentInfo: { lVal18AFC: "کسرام", zTitad: 1000000000, flowTitle: "بورس" } } });
    else await route.fulfill({ json: {} });
    return;
  }
  if (enableDirect && request.url().includes("zarvanfund.ir")) {
    await route.fulfill({ json: { "کسرام": { InsCode: "K" }, "کفپارس": { InsCode: "F" } } });
    return;
  }
  if (endpoint === "/api/screener") {
    const { symbols } = request.postDataJSON();
    requests.push(symbols);
    await route.fulfill({ json: {
      rows: symbols.map((symbol) => ({
        symbol, insCode: symbol, rsi: 25, realHolders: null, status: "ready", actions: [],
        three: calculatePeriod(history, 90), six: calculatePeriod(history, 180),
        peakDrops: { "1m": calculatePeriod(history, 30), "2m": calculatePeriod(history, 60), "3m": calculatePeriod(history, 90) },
      })), latestDate: 20260907, fetchedAt: "2026-09-07T10:00:00Z",
    } });
  } else if (endpoint === "/api/market-highlights") {
    const { symbols } = request.postDataJSON();
    highlightScans.push(symbols);
    if (slowHighlights && symbols.includes("کسرام")) await highlightGate;
    await route.fulfill({ json: { rows: symbols.map((symbol, index) => marketHighlightFromInstrument({
      Symbol: symbol, InsCode: symbol, Date: 20260907, PriceYesterday: 1000, PriceClose: 970, PriceLast: 1020,
      PriceMin: 970, AllowedMin: 970, Volume: 1000 + index, Value: 10000 + index, NetRealValue: 5000 + index,
    })), fetchedAt: "2026-09-07T10:00:00Z", latestDate: 20260907 } });
  } else if (endpoint === "/api/holder-increases") {
    const body = request.method() === "POST" ? request.postDataJSON() : null;
    if (body?.instruments) {
      await route.fulfill({ json: { summaries: Object.fromEntries(body.instruments.map(({ symbol }) => [symbol, { buyCount: symbol === "کفپارس" ? 2 : 1, sellCount: 0, buyShares: 100, sellShares: 0 }])), sourceDate: 20260907 } });
    } else {
      if (failHoldings) { await route.fulfill({ status: 502, body: "<html>upstream unavailable</html>" }); return; }
      const symbols = body?.symbols ?? ["بازارآزمایشی"];
      holdingScans.push(body?.symbols ?? "market");
      const rows = symbols.map((symbol) => ({
        id: symbol, insCode: symbol, symbol, instrumentName: symbol, shareholderType: "شخص حقیقی", previousShares: 100,
        currentShares: 150, changeShares: 50, changeEvidence: "snapshot", ownershipPct: 15, market: "بورس", date: 20260907,
      }));
      if (symbols.includes("کسرام")) rows.push({ ...rows.find((row) => row.symbol === "کسرام"), id: "کسرام-سهامدار-دوم", currentShares: 13000000, changeShares: 1000000, ownershipPct: 1.276 });
      await route.fulfill({ json: { rows, sourceDate: 20260907, fetchedAt: "2026-09-07T10:00:00Z", nextCursor: null, fallback: enableDirect } });
    }
  } else {
    await route.fulfill({ json: { rows: [], counts: {}, summaries: {} } });
  }
});
const page = await context.newPage();
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(process.env.QA_BASE_URL || "http://127.0.0.1:3000/");
  await page.getByRole("button", { name: "ورود به برنامه", exact: true }).click();
  await page.getByRole("cell").filter({ hasText: "کسرام" }).first().waitFor();
  assert.deepEqual(requests[0], ["کسرام"], "Initial load must use the saved active watchlist.");

  await page.getByRole("button", { name: "افت از سقف ۳ ماهه", exact: true }).click();
  await page.getByRole("button", { name: "۱ ماه", exact: true }).click();
  assert.match(await page.locator("tbody tr").first().innerText(), /۲۰٪/);
  await page.getByRole("button", { name: "۲ ماه", exact: true }).click();
  assert.match(await page.locator("tbody tr").first().innerText(), /۵۰٪/);
  await page.getByRole("button", { name: "۳ ماه", exact: true }).click();
  assert.match(await page.locator("tbody tr").first().innerText(), /۷۵٪/);

  await page.getByRole("button", { name: /مدیریت نماد دلخواه/ }).click();
  await page.getByRole("textbox", { name: "فهرست نمادها", exact: true }).fill("رتبه\tنماد\tقیمت\n1\tکفپارس\t۵۰۰\n۲. هم ارز ۱٬۲۹۰ −۳٪\nکفپارس");
  await page.getByRole("button", { name: "ذخیره فهرست", exact: true }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("ss-custom-v1")).length === 2);
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem("ss-custom-v1"))), ["کفپارس", "هم ارز"]);
  await page.getByRole("cell").filter({ hasText: "هم ارز" }).first().waitFor();
  await page.getByRole("button", { name: "خرید حقیقی", exact: false }).filter({ hasText: "↕" }).click();
  assert.match(await page.locator("tbody tr").first().innerText(), /کفپارس/);
  await page.getByRole("button", { name: "🟢 خرید حقیقی عمده", exact: true }).click();
  assert.equal(await page.locator("tbody tr").count(), 2);

  const scopes = [
    ["حقیقی", ["کفپارس", "کسرام"]], ["زرد/نارنجی", ["سپیدار", "کسرام"]],
    ["دلخواه", ["کفپارس", "هم ارز"]], ["کل واچ‌لیست", ["کفپارس", "کسرام", "سپیدار", "هم ارز"]],
  ];
  await page.getByRole("button", { name: /بیشترین‌های فهرست/ }).click();
  const highlightGroup = page.getByRole("group", { name: "محدوده اسکن بیشترین‌ها" });
  assert.equal(await highlightGroup.getByRole("button").count(), 4);
  for (const [label, symbols] of scopes) {
    const response = page.waitForResponse((res) => res.url().includes("/api/market-highlights"));
    await highlightGroup.getByRole("button", { name: `اسکن ${label} (${new Intl.NumberFormat("fa-IR").format(symbols.length)})`, exact: true }).click();
    await response;
    await page.getByRole("button", { name: /بروزرسانی رتبه‌بندی‌ها/ }).waitFor();
    assert.deepEqual(highlightScans.at(-1), symbols);
    assert.equal(await page.getByRole("table", { name: "بیشترین ارزش معاملات", exact: true }).locator("tbody tr").count(), symbols.length);
  }
  assert.equal(await page.getByRole("table", { name: "بیشترین ارزش معاملات", exact: true }).getByRole("columnheader").count(), 5);
  const holderRanking = page.getByRole("table", { name: "تغییرات سهامدار حقیقی", exact: true });
  await holderRanking.locator("tbody tr").first().waitFor();
  assert.equal(await holderRanking.getByRole("columnheader").count(), 4);
  assert.equal(await holderRanking.locator("tbody tr").count(), 5);
  assert.equal(await holderRanking.locator("tbody tr").filter({ hasText: "کسرام" }).count(), 2);
  assert.match(await holderRanking.innerText(), /درصد مالکیت/);
  assert.equal(await page.locator(".highlight-card").count(), 5);
  assert.equal(await page.getByRole("table", { name: "بیشترین ارزش معاملات", exact: true }).locator("tbody tr").first().locator("td").last().innerText(), "۵");

  await mkdir("work/qa", { recursive: true });
  await page.screenshot({ path: "work/qa/base-fixes-desktop.png", fullPage: true });
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const sizes = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(sizes.page <= sizes.viewport + 1, `Page overflows at width ${width}: ${JSON.stringify(sizes)}`);
  }
  slowHighlights = true;
  const oldResponse = page.waitForResponse((res) => res.url().includes("/api/market-highlights") && res.request().postDataJSON().symbols.includes("کسرام"));
  await highlightGroup.getByRole("button", { name: "اسکن حقیقی (۲)", exact: true }).click();
  const freshResponse = page.waitForResponse((res) => res.url().includes("/api/market-highlights") && res.request().postDataJSON().symbols.includes("هم ارز"));
  await highlightGroup.getByRole("button", { name: "اسکن دلخواه (۲)", exact: true }).click();
  await freshResponse;
  releaseHighlight();
  await oldResponse;
  await page.getByRole("heading", { name: "بیشترین‌های بازار برای نمادهای دلخواه", exact: true }).waitFor();
  assert.doesNotMatch(await page.getByRole("table", { name: "بیشترین ارزش معاملات", exact: true }).innerText(), /کسرام/);
  slowHighlights = false;
  await page.getByRole("button", { name: "خ خرید حقیقی عمده", exact: true }).click();
  const holderGroup = page.getByRole("group", { name: "محدوده اسکن خرید حقیقی عمده" });
  assert.equal(await holderGroup.getByRole("button").count(), 5);
  for (const [label, symbols] of [...scopes, ["کل بازار", undefined]]) {
    const response = page.waitForResponse((res) => res.url().includes("/api/holder-increases"));
    const name = `اسکن ${label}${symbols ? ` (${new Intl.NumberFormat("fa-IR").format(symbols.length)})` : ""}`;
    await holderGroup.getByRole("button", { name, exact: true }).click();
    await response;
    await page.getByRole("button", { name: "بروزرسانی تغییرات", exact: true }).waitFor();
    assert.deepEqual(holdingScans.at(-1), symbols ?? "market");
    assert.equal(await page.locator("tbody tr").count(), symbols ? symbols.length + Number(symbols.includes("کسرام")) : 1);
  }
  failHoldings = true;
  await page.getByRole("button", { name: "بروزرسانی تغییرات", exact: true }).click();
  await page.getByRole("alert").waitFor();
  assert.match(await page.getByRole("alert").innerText(), /پاسخ سرور قابل پردازش نبود/);
  assert.equal(await page.locator("tbody tr").count(), 1, "A failed refresh preserves the prior result for the same scope.");
  failHoldings = false;
  enableDirect = true;
  await holderGroup.getByRole("button", { name: "اسکن حقیقی (۲)", exact: true }).click();
  await page.getByRole("button", { name: "بروزرسانی تغییرات", exact: true }).waitFor();
  await page.getByRole("cell", { name: "۱٬۰۰۰٬۰۰۰", exact: false }).first().waitFor();
  assert.equal(await page.locator("tbody tr").count(), 2);
  assert.equal(await page.locator("tbody tr").filter({ hasText: "کسرام" }).count(), 2);
  assert.match(await page.locator("tbody").innerText(), /۸۴۶٬۲۹۷/);
  assert.deepEqual(errors, [], "Browser runtime errors");
  console.log("PASS: saved watchlist, periods, TXT, holder sorting/filter, four ranking scopes, five holder scopes, five cards, separate holders, percentage-point gap, stale response race, failure handling, four viewport widths, no page errors.");
} catch (error) {
  console.error(JSON.stringify({ requests, errors, body: (await page.locator("body").innerText()).slice(0, 4000) }));
  await mkdir("work/qa", { recursive: true });
  await page.screenshot({ path: "work/qa/failure.png", fullPage: true });
  throw error;
} finally {
  await browser.close();
}
