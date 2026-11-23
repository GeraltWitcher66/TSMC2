/** Bounded, non-destructive smoke for the actual deployed front end.
 * Three live screener/price symbols maximum. Holder/official heavy routes mocked.
 * This tests rendering and interaction, NOT correctness of all market data.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const SITE_URL = 'https://iran-stock-screener.ar-nikzad09.workers.dev/';
const symbols = ['فولاد', 'کسرا', 'حیات'];
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const pageErrors = [], unsafe = [], coreHttpErrors = [];
let screenerCalls = 0, directPriceCalls = 0, mockedHolders = 0, renderedCards = 0;
page.on('pageerror', e => pageErrors.push(e.message.slice(0, 250)));
page.on('response', r => {
  if (/\/api\/(screener|market-highlights)(\?|$)/.test(r.url()) && r.status() >= 500)
    coreHttpErrors.push(`${new URL(r.url()).pathname} ${r.status()}`);
});

try {
  await context.addInitScript(list => {
    localStorage.setItem('ss-haghighi-v1', JSON.stringify(list));
    localStorage.setItem('ss-active-source-v1', 'haghighi');
    localStorage.setItem('ss-favorites-v1', '[]');
  }, symbols);

  // Every real market request originating from the app stays within 3 symbols.
  await context.route('**/api/screener**', async route => {
    const names = route.request().postDataJSON()?.symbols ?? [];
    if (names.length > 3) { unsafe.push(`screener count=${names.length}`); return route.abort(); }
    screenerCalls++;
    await route.continue();
  });
  await context.route('https://zarvanfund.ir/api/**', async route => {
    const u = new URL(route.request().url());
    const names = (u.searchParams.get('syms') ?? '').split(',').filter(Boolean);
    if (names.length > 3) { unsafe.push(`direct ${u.pathname} count=${names.length}`); return route.abort(); }
    directPriceCalls++;
    await route.continue();
  });

  // Do not trigger a full-market or live holder scan while checking UI rendering.
  await context.route('**/api/market-universe**', async route => {
    unsafe.push('unexpected market-universe request');
    await route.fulfill({ status: 400, json: { error: 'disabled in bounded smoke' } });
  });
  await context.route('**/api/holders**', async route => {
    unsafe.push('unexpected holders scan');
    await route.fulfill({ status: 400, json: { error: 'disabled in bounded smoke' } });
  });
  await context.route('**/api/holder-increases**', async route => {
    mockedHolders++;
    await route.fulfill({ json: {
      rows: [{ id: 'smoke-1', symbol: 'فولاد', instrumentName: 'فولاد مبارکه', shareholderType: 'شخص حقیقی', market: 'بورس',
        previousShares: 100000, currentShares: 105000, changeShares: 5000, ownershipPct: 0.01, date: 20261024 }],
      sourceDate: 20261024, fetchedAt: new Date().toISOString(), partial: false, fallback: false, nextCursor: null,
    } });
  });
  // Official quote enrichment is optional and intentionally not audited here.
  await context.route('https://cdn.tsetmc.com/**', route => route.fulfill({ status: 503, body: '' }));
  await context.route('**/api/tsetmc-relay**', route => route.fulfill({ status: 503, body: '' }));

  const response = await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  assert.equal(response.status(), 200);
  await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('section.panel tbody tr').length === 3,
    null, { timeout: 45_000 });
  // The first button press may precede hydration of the server-rendered modal.
  if (await page.locator('.welcome-modal').isVisible()) {
    await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  }
  await page.locator('.welcome-modal').waitFor({ state: 'detached', timeout: 12_000 });
  assert.equal(await page.locator('.tabs button').count(), 6);
  assert.equal(await page.locator('section.panel tbody tr').count(), 3);
  const threeFirst = await page.locator('section.panel tbody tr').allInnerTexts();
  assert.ok(threeFirst.some(x => x.includes('فولاد')));
  assert.ok(threeFirst.some(x => x.includes('کسرا')));
  console.log('PASS 90-day UI: 3 source-dated stock rows and 6 navigation tabs');

  const search = page.getByRole('searchbox', { name: 'جستجو در نمادها' });
  await search.fill('فولاد');
  assert.equal(await page.locator('section.panel tbody tr').count(), 1);
  await search.fill('');
  assert.equal(await page.locator('section.panel tbody tr').count(), 3);
  await page.getByRole('button', { name: /فقط RSI/ }).click();
  assert.ok((await page.locator('.mode-switch button.active').allInnerTexts()).some(s => s.includes('RSI')));
  await page.getByRole('button', { name: 'همه نمادها' }).click();
  await page.locator('section.panel tbody tr').first().getByRole('button', { name: '⭐' }).click();
  await page.getByRole('button', { name: /تحلیل واگرایی/ }).first().click();
  assert.equal(await page.getByRole('dialog').count(), 1);
  await page.getByRole('dialog').getByRole('button', { name: 'بستن' }).click();

  await page.getByRole('button', { name: /فیلتر ۱۸۰ روزه/ }).click();
  assert.equal(await page.locator('section.panel tbody tr').count(), 3);
  await page.getByRole('button', { name: /نمادهای منتخب/ }).click();
  assert.equal(await page.locator('section.panel tbody tr').count(), 1);
  await page.getByRole('button', { name: /مدیریت نماد دلخواه/ }).click();
  assert.equal(await page.getByRole('dialog').count(), 1);
  await page.getByRole('dialog').getByRole('button', { name: 'بستن' }).click();
  console.log('PASS interactions: search, RSI filter, favorite, divergence modal, 180-day tab and list-manager modal');

  await page.getByRole('button', { name: /حقیقی‌های عمده کل بازار/ }).click();
  await page.getByRole('heading', { name: /تعداد سهامداران عمده/ }).waitFor();
  assert.equal(await page.locator('section.holders-panel').count(), 1);
  console.log('PASS holders UI: tab rendered without initiating a whole-market scan');

  await page.getByRole('button', { name: /خرید حقیقی عمده/ }).first().click();
  await page.getByRole('heading', { name: /خرید \/ افزایش سهام/ }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.holder-group-row').length === 1,
    null, { timeout: 10_000 });
  assert.equal(await page.locator('.holder-group-row').count(), 1);
  console.log('PASS holder-increases UI: mocked source record rendered');

  await page.getByRole('button', { name: /بیشترین‌های فهرست/ }).click();
  await page.locator('.highlight-card').first().waitFor({ timeout: 10_000 });
  renderedCards = await page.locator('.highlight-card').count();
  assert.equal(renderedCards, 5);
  await page.waitForFunction(() => {
    const el = document.querySelector('.highlights-panel [role="status"]');
    return el && /قیمت تاریخ‌دار [۱۲۳]/.test(el.textContent ?? '');
  }, null, { timeout: 35_000 });
  console.log('PASS highlights UI: 5 cards and at least 1 real date-stamped stock quote');

  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unsafe, []);
  console.log(JSON.stringify({ status:'PASS', screenerCalls, directPriceCalls, mockedHolders, renderedCards,
    coreHttpErrors, pageErrors, unexpectedBulkRequests: unsafe }, null, 2));
} catch (e) {
  console.error('SMOKE_DIAGNOSTIC', JSON.stringify({ error: e.message, screenerCalls, directPriceCalls, mockedHolders, renderedCards,
    pageErrors, unsafe, coreHttpErrors, activeTab: await page.locator('.tabs .active').first().innerText().catch(() => '?'),
    alerts: await page.locator('[role="alert"]').allInnerTexts().catch(() => []) }));
  process.exitCode = 1;
} finally {
  await browser.close();
}
