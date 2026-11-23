import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('ss-haghighi-v1', JSON.stringify(['فولاد']));
    localStorage.setItem('ss-active-source-v1', 'haghighi');
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (String(key).startsWith('ss-')) throw new DOMException('Storage quota denied', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await context.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/screener') {
      const symbols = route.request().postDataJSON()?.symbols ?? [];
      return route.fulfill({ json: { latestDate: 20261017, fetchedAt: new Date().toISOString(), rows: symbols.map((symbol) => ({
        symbol, name: symbol, insCode: 'test-' + symbol, status: 'ready', rsi: 50,
        realHolders: null, three: { startDate: 20260717, peakDate: 20261015, currentDate: 20261017,
          startPrice: 100, peakPrice: 112, currentPrice: 107, returnPct: 7, drawdownPct: 4.46 },
        six: { startDate: 20260417, peakDate: 20261015, currentDate: 20261017,
          startPrice: 90, peakPrice: 112, currentPrice: 107, returnPct: 18.89, drawdownPct: 4.46 },
        actions: [],
      })) } });
    }
    return route.fulfill({ json: { rows: [], fetchedAt: new Date().toISOString() } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.SITE_TEST_URL || 'http://127.0.0.1:3191/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 8000 });
  await page.locator('tbody tr .star-button').first().click();
  await page.getByRole('alert').getByText(/ذخیره‌سازی مرورگر محدود/).waitFor();
  await page.getByRole('button', { name: /مدیریت نماد حقیقی/ }).click();
  await page.getByRole('textbox', { name: 'فهرست نمادها', exact: true }).fill('فولاد\nفنر');
  await page.getByRole('button', { name: 'ذخیره فهرست', exact: true }).click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 8000 });
  assert.equal(await page.getByRole('button', { name: /مدیریت نماد حقیقی/ }).innerText().then((text) => text.includes('۲')), true);
  assert.deepEqual(errors, [], 'storage quota failure must not crash React rendering');
  assert.equal(await page.getByRole('alert').filter({ hasText: /ذخیره‌سازی مرورگر/ }).count(), 1);
  await context.close();
  console.log('PASS: persistent storage denial does not crash watchlists/favorites and clearly warns about session-only edits.');
} finally {
  await browser.close();
}
