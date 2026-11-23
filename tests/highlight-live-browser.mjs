// Deliberately forces the ranking Worker endpoint to 503, while retrieving
// just two actual dated stocks directly from Zarvan through browser CORS.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const symbols = ['کسرام', 'فنر'];
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext();
const page = await context.newPage();
let worker503s = 0, directRequests = 0;
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
try {
  await context.addInitScript((s) => {
    localStorage.setItem('ss-haghighi-v1', JSON.stringify(s));
    localStorage.setItem('ss-active-source-v1', 'haghighi');
  }, symbols);
  await context.route('https://zarvanfund.ir/api/**', async (route) => { directRequests++; await route.continue(); });
  await context.route('https://cdn.tsetmc.com/api/**', async (route) => route.fulfill({ status: 503, body: '' }));
  await context.route('**/api/**', async (route) => {
    const path = new URL(route.request().url());
    if (path.hostname === 'zarvanfund.ir') return route.fallback();
    if (path.pathname === '/api/market-highlights') {
      worker503s++;
      await route.fulfill({ status: 503, body: '<html>edge overloaded</html>', contentType: 'text/html' });
    } else if (path.pathname === '/api/holder-increases') {
      await route.fulfill({ json: { rows: [], sourceDate: 20261014, fetchedAt: new Date().toISOString(), partial: true, fallback: false, nextCursor: null } });
    } else if (path.pathname === '/api/screener') {
      const requested = route.request().postDataJSON()?.symbols ?? [];
      await route.fulfill({ json: { rows: requested.map(symbol => ({ symbol, name: symbol, actions: [], three: { currentDate: '20261014', currentPrice: 100 }, six: { currentDate: '20261014', currentPrice: 100 }, realHolders: null, rsi: null })), latestDate: 20261014 } });
    } else await route.fulfill({ json: {} });
  });

  await page.goto(process.env.HIGHLIGHTS_BASE_URL || 'http://127.0.0.1:3191/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  await page.getByRole('button', { name: /بیشترین‌های فهرست/ }).click();
  await page.waitForFunction(() => {
    const panel = document.querySelector('.highlights-panel');
    const coverage = panel?.querySelector('[role="status"]')?.textContent ?? '';
    return coverage.includes('قیمت تاریخ‌دار ۲') && coverage.includes('حجم ۲') && coverage.includes('ارزش معاملات ۲');
  }, null, { timeout: 60_000 });
  const coverage = await page.locator('.highlights-panel [role="status"]').first().innerText();
  assert.match(coverage, /دریافت‌نشده ۰/);
  assert.equal(worker503s, 0, 'verified dated direct source must avoid Worker 503 entirely');
  assert.ok(directRequests >= 2);
  assert.deepEqual(errors, []);
  console.log(`PASS real browser CORS: ${symbols.join(',')} recovered dated prices, volume and value without hitting Worker; ${directRequests} actual Zarvan requests.`);
} catch (error) {
  console.error('REAL_CORS_DIAGNOSTICS', JSON.stringify({ worker503s, directRequests, errors,
    coverage: await page.locator('.highlights-panel [role="status"]').first().innerText().catch(() => ''),
    warning: await page.locator('.highlights-panel .scan-error').first().innerText().catch(() => '') }));
  throw error;
} finally { await browser.close(); }
