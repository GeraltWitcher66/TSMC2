// Focused browser smoke: real React flow, mocked provider APIs. No live market scan.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const alphabet = 'ابپتثجچحخدذرزسشصضطظعغفقکگلمنوهی';
const symbols = Array.from({ length: 660 }, (_, i) => ({
  symbol: `نماد${alphabet[Math.floor(i / alphabet.length)]}${alphabet[i % alphabet.length]}`,
  name: `شرکت آزمایشی ${i + 1}`,
  market: 'بورس',
}));
const holderCalls = [];
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

try {
  await context.addInitScript(() => {
    localStorage.setItem('ss-active-source-v1', 'custom');
    localStorage.setItem('ss-custom-v1', JSON.stringify(['فولاد']));
  });
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/market-universe') {
      await route.fulfill({ json: { symbols, partial: true, fetchedAt: '2026-10-15T09:00:00Z' } });
    } else if (path === '/api/holders') {
      const requested = route.request().postDataJSON().symbols;
      holderCalls.push(requested);
      await route.fulfill({ json: { counts: Object.fromEntries(requested.map((symbol) => [symbol,
        symbol === symbols[1].symbol ? 0 : symbol === symbols[2].symbol ? null : 2])), partial: requested.includes(symbols[2].symbol) } });
    } else {
      await route.fulfill({ json: { rows: [], latestDate: null, fetchedAt: '2026-10-15T09:00:00Z' } });
    }
  });

  await page.goto(process.env.SITE_TEST_URL || 'http://127.0.0.1:3187/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 7000 });
  await page.getByRole('button', { name: /حقیقی‌های عمده کل بازار/ }).click();
  await page.locator('.holders-panel').getByRole('button', { name: 'اسکن کل بازار', exact: true }).click();
  await page.locator('.holders-panel tbody tr').first().waitFor();
  assert.equal(await page.locator('.holders-panel tbody tr').count(), 660);
  await page.getByText('فهرست بازار ناقص دریافت شده است', { exact: false }).waitFor();
  await page.waitForFunction(() => document.querySelector('.holders-panel .market-stat')?.textContent?.includes('۹'));
  assert.equal(holderCalls.length, 1, 'one bounded batch must have completed');
  assert.equal(holderCalls[0].length, 10);
  assert.match(await page.locator('.holders-panel tbody tr').filter({ hasText: symbols[1].symbol }).innerText(), /بدون حقیقی عمده تأییدشده/);
  assert.match(await page.locator('.holders-panel tbody tr').filter({ hasText: symbols[2].symbol }).innerText(), /دسترس‌نبود/);
  await page.getByRole('button', { name: 'توقف اسکن', exact: true }).click();
  const resumedResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/holders');
  await page.getByRole('button', { name: 'شروع / ادامه اسکن', exact: true }).click();
  await resumedResponse;
  assert.ok(holderCalls.length >= 2, 'resume must issue a new batch');
  for (const s of holderCalls[0].filter((s) => s !== symbols[2].symbol)) {
    assert.equal(holderCalls[1].includes(s), false, `verified ${s} must not be requested again`);
  }
  assert.ok(holderCalls[1].includes(symbols[2].symbol), 'unavailable symbol should be retried');
  assert.deepEqual(pageErrors, [], 'browser must have no runtime exceptions');
  await page.getByRole('button', { name: 'توقف اسکن', exact: true }).click();
  console.log('PASS browser: partial 660 list, visible verified/zero/unavailable rows, resume skips verified requests, no runtime errors.');
} finally {
  await browser.close();
}
