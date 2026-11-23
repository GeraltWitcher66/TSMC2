import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext();
const page = await context.newPage();
let workerCalls = 0;
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await context.addInitScript(() => {
    localStorage.setItem('ss-haghighi-v1', JSON.stringify(['کسرام', 'فنر']));
    localStorage.setItem('ss-active-source-v1', 'haghighi');
  });
  await context.route('https://zarvanfund.ir/api/**', route => route.fulfill({ status: 503, contentType: 'text/html', body: 'unavailable', headers: { 'access-control-allow-origin': '*' } }));
  await context.route('**/api/**', async route => {
    const path = new URL(route.request().url());
    if (path.hostname === 'zarvanfund.ir') return route.fallback();
    if (path.pathname === '/api/market-highlights') {
      workerCalls++;
      const requested = route.request().postDataJSON()?.symbols || [];
      const rows = requested.map((symbol, i) => ({ symbol, name: symbol,
        insCode: String(i + 100), sessionDate: 20261014,
        priceLast: 105, priceClose: 104, priceMin: 99, priceFirst: 100, priceYesterday: 102,
        volume: 10000, value: 1040000, volumeAvailable: true, valueAvailable: true,
        lastChangePct: 2, closeChangePct: 1,
        lastCloseGapPct: 1, clientTypeAvailable: false, netRealValue: null,
        realBuyValue: null, realSellValue: null, floorVerified: false, allowedMin: 0 }));
      return route.fulfill({ json: { rows, latestDate: 20261014, partial: false, fetchedAt: new Date().toISOString() } });
    }
    if (path.pathname === '/api/screener') return route.fulfill({ json: { rows: [], latestDate: null } });
    if (path.pathname === '/api/holder-increases') return route.fulfill({ json: { rows: [], fallback: true, sourceDate: 20260907, nextCursor: null } });
    return route.fulfill({ json: {} });
  });
  await page.goto(process.env.HIGHLIGHT_TEST_URL || 'http://127.0.0.1:3187/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.locator('.welcome-btn').click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached' });
  await page.locator('nav.tabs button').nth(2).click();
  await page.waitForFunction(() => (document.querySelector('.highlights-panel [role="status"]')?.textContent || '').includes('قیمت تاریخ‌دار ۲'), null, { timeout: 25000 });
  assert.equal(workerCalls, 1, 'Worker is called when direct Zarvan CORS source fails');
  assert.match(await page.locator('.highlights-panel [role="status"]').first().innerText(), /دریافت‌نشده ۰/);
  assert.equal(await page.locator('.highlight-card').first().locator('tbody tr').count(), 2);
  assert.deepEqual(errors, []);
  console.log('PASS highlights fallback: Zarvan 503 -> Worker 200, both verified dated prices displayed.');
} finally { await browser.close(); }
