import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const testUrl = process.env.SITE_TEST_URL || 'http://127.0.0.1:3199/';
const sample = (symbol) => ({ symbol, name: symbol, insCode: '123', realHolders: null, rsi: 48,
  three: { startDate: '20260716', currentDate: '20261014', peakDate: '20261013', startPrice: 100, peakPrice: 110, currentPrice: 102, drawdownPct: 7.27, returnPct: 2 },
  six: { startDate: '20260416', currentDate: '20261014', peakDate: '20261013', startPrice: 90, peakPrice: 110, currentPrice: 102, drawdownPct: 7.27, returnPct: 13.33 },
  actions: [], status: 'warning', note: 'تاریخ داده نمونه آزمون' });
const dataRoute = async (route) => {
  const pathname = new URL(route.request().url()).pathname;
  if (pathname === '/api/screener') {
    const symbols = route.request().postDataJSON()?.symbols || [];
    return route.fulfill({ json: { rows: symbols.map(sample), latestDate: 20261014, fetchedAt: new Date().toISOString() } });
  }
  if (pathname === '/api/market-highlights') {
    return route.fulfill({ status: 503, contentType: 'text/html', body: '<html>503</html>' });
  }
  if (pathname === '/api/holder-increases') return route.fulfill({ json: { rows: [], sourceDate: 20260907, fetchedAt: new Date().toISOString(), fallback: true, partial: false } });
  return route.fulfill({ json: {} });
};

try {
  // Switching tabs while a ranking API fails must not surface a screener error
  // in the unrelated screen, and the banner must describe the active tab.
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await context.addInitScript(() => { localStorage.setItem('ss-haghighi-v1', JSON.stringify(['کسرام'])); localStorage.setItem('ss-active-source-v1', 'haghighi'); });
  await context.route('**/api/**', dataRoute);
  await context.route('https://zarvanfund.ir/api/**', route => route.fulfill({ status: 503, headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await page.goto(testUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('.welcome-btn').click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 7000 });
  await page.locator('nav.tabs button').nth(2).click();
  await page.waitForTimeout(1000);
  const banner = await page.locator('.notice-copy').innerText();
  assert.match(banner, /رتبه‌بندی/);
  assert.doesNotMatch(banner, /تاریخ و قیمت تک‌تک نمادها|سابقه قیمت/);
  assert.equal(await page.locator('.scan-error').count(), 0, '90/180 error must not leak to highlights');
  assert.deepEqual(errors, []);
  await context.close();

  // A favorite belonging to an inactive source must still appear after cold
  // reload, even before its dated price has been recovered.
  const favorites = await browser.newContext();
  const fPage = await favorites.newPage();
  const fErrors = [];
  fPage.on('pageerror', e => fErrors.push(e.message));
  await favorites.addInitScript(() => {
    localStorage.setItem('ss-haghighi-v1', JSON.stringify(['کسرام']));
    localStorage.setItem('ss-custom-v1', JSON.stringify(['افق']));
    localStorage.setItem('ss-favorites-v1', JSON.stringify(['افق']));
    localStorage.setItem('ss-active-source-v1', 'haghighi');
  });
  await favorites.route('**/api/**', dataRoute);
  await fPage.goto(testUrl, { waitUntil: 'domcontentloaded' });
  await fPage.waitForTimeout(1200);
  await fPage.locator('.welcome-btn').click();
  await fPage.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 7000 });
  await fPage.locator('nav.tabs button').nth(5).click();
  await fPage.locator('.holders-panel tbody tr').first().waitFor({ timeout: 15000 });
  assert.match(await fPage.locator('.holders-panel tbody tr').first().innerText(), /افق/);
  assert.equal(await fPage.locator('.holders-panel tbody tr').count(), 1);
  await fPage.waitForTimeout(250);
  assert.deepEqual(fErrors, []);
  await favorites.close();
  console.log('PASS UI isolation and favorites cold reload without source-tab contamination or JS exceptions.');
} finally { await browser.close(); }
