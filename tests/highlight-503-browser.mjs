import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { defaultSymbols } from '../app/default-symbols.ts';
import { toApiSymbol } from '../app/lib/market.ts';

const EXPECTED = defaultSymbols.length;
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext();
const page = await context.newPage();
// Fixture sessions are 2026-10-14 (equities) and 2026-10-15 (Thursday
// commodity): replay with their actual market clock, not execution day.
await page.clock.install({ time: new Date('2026-10-15T14:00:00Z') });
const errors = [];
let workerBatches = 0, dailyBatches = 0, snapshotBatches = 0, holderCalls = 0;
let holderStartPriceBatches = null;
let brokenSymbols = new Set();
let mixedCommoditySession = false;
page.on('pageerror', (error) => errors.push(error.message));
const sample = {
  d_even: 20261014, open: 100, high: 112, low: 98, close: 105,
  last: 107, yesterday: 103, volume: 20000, value: 2100000,
};
const holderRows = defaultSymbols.slice(0, 12).map((symbol, i) => ({
  id: `holder-${i}`, insCode: String(1000 + i), instrumentName: symbol,
  shareholderType: 'شخص حقیقی', symbol, market: 'بورس',
  previousShares: 500000, currentShares: 500012 - i, changeShares: 12 - i,
  changeEvidence: 'official', date: 20261014, ownershipPct: 1,
}));

try {
  await context.addInitScript((symbols) => {
    localStorage.setItem('ss-haghighi-v1', JSON.stringify(symbols));
    localStorage.setItem('ss-active-source-v1', 'haghighi');
  }, defaultSymbols);
  await context.route('https://zarvanfund.ir/api/**', async (route) => {
    const url = new URL(route.request().url());
    const names = (url.searchParams.get('syms') ?? '').split(',').filter(Boolean);
    if (names.some((name) => brokenSymbols.has(name))) {
      await route.fulfill({ status: 503, contentType: 'text/html', body: '<html>upstream 503</html>', headers: { 'access-control-allow-origin': '*' } });
      return;
    }
    if (url.pathname.endsWith('/daily-batch')) {
      dailyBatches++;
      await route.fulfill({ json: Object.fromEntries(names.map((name) => [name, [
        mixedCommoditySession && name === toApiSymbol(defaultSymbols[0]) ? { ...sample, d_even: 20261015 } : sample,
      ]])), headers: { 'access-control-allow-origin': '*' } });
    } else if (url.pathname.endsWith('/instruments')) {
      snapshotBatches++;
      await route.fulfill({ json: Object.fromEntries(names.map((name, i) => [name, { Name: mixedCommoditySession && name === toApiSymbol(defaultSymbols[0]) ? 'صندوق س.کالای آزمایشی' : name, InsCode: `${snapshotBatches}-${i}`, Date: 0 }])), headers: { 'access-control-allow-origin': '*' } });
    } else await route.fulfill({ status: 404, body: '' });
  });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'zarvanfund.ir') return route.fallback();
    if (url.pathname === '/api/market-highlights') {
      workerBatches++;
      await route.fulfill({ status: 503, contentType: 'text/html', body: '<html>temporary 503</html>' });
    } else if (url.pathname === '/api/screener') {
      // Keep the automatic 90/180 background load isolated. It is not the
      // subject of this test, and must not create extra Zarvan requests.
      const symbols = route.request().postDataJSON()?.symbols ?? [];
      await route.fulfill({ json: { rows: symbols.map(symbol => ({ symbol, name: symbol,
        status: 'warning', rsi: null, realHolders: null, actions: [],
        three: { startPrice: 100, peakPrice: 120, currentPrice: 110, currentDate: '20261014', returnPct: 10, drawdownPct: 8 },
        six: { startPrice: 100, peakPrice: 120, currentPrice: 110, currentDate: '20261014', returnPct: 10, drawdownPct: 8 },
      })), latestDate: 20261014 } });
    } else if (url.pathname === '/api/holder-increases') {
      holderCalls++;
      if (holderStartPriceBatches === null) holderStartPriceBatches = workerBatches;
      await route.fulfill({ json: { rows: holderRows, sourceDate: 20261014, fetchedAt: new Date().toISOString(), partial: false, fallback: false, nextCursor: null } });
    } else await route.fulfill({ json: { rows: [], latestDate: null, fetchedAt: new Date().toISOString() } });
  });

  await page.goto(process.env.HIGHLIGHT_TEST_URL || 'http://127.0.0.1:3191/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 7000 });
  await page.getByRole('button', { name: /بیشترین‌های فهرست/ }).click();
  await page.waitForFunction(() => {
    const panel = document.querySelector('.highlights-panel');
    const coverage = panel?.querySelector('[role="status"]')?.textContent ?? '';
    const cards = panel?.querySelectorAll('.highlight-card') ?? [];
    return cards.length === 5 && coverage.includes('۱۷۸') && coverage.includes('دریافت‌نشده ۰');
  }, null, { timeout: 90_000 });
  await page.getByRole('button', { name: /بروزرسانی رتبه‌بندی‌ها/ }).waitFor();
  const coverageText = await page.locator('.highlights-panel [role="status"]').first().innerText();
  assert.match(coverageText, /قیمت تاریخ‌دار ۱۷۸/);
  assert.match(coverageText, /حجم ۱۷۸/);
  assert.match(coverageText, /ارزش معاملات ۱۷۸/);
  assert.match(coverageText, /حجم حقیقی ۰/);
  assert.match(coverageText, /کف مجاز ۰/);
  assert.equal(await page.locator('.highlights-intro').getByText(/پوشش قیمت، حجم یا ارزش معاملات کامل نیست/).count(), 0,
    'missing official ClientType/floor must not make complete price coverage look incomplete');
  assert.equal(workerBatches, 0, 'healthy dated direct prices must not create 18 expensive Worker requests');
  assert.equal(dailyBatches, Math.ceil(EXPECTED / 10));
  assert.equal(snapshotBatches, Math.ceil(EXPECTED / 10));
  assert.equal(holderStartPriceBatches, 0, 'holder requests must start AFTER price ranking is complete');
  assert.equal(await page.locator('.highlight-card').first().locator('tbody tr').count(), 10);
  assert.equal(await page.locator('.highlight-card').nth(1).locator('tbody tr').count(), 10);
  await page.waitForFunction(() => document.querySelectorAll('.holder-highlight-card .holder-group-head').length === 12);
  assert.equal(await page.locator('.holder-highlight-card .holder-group-head').count(), 12,
    'holder card displays every one of the 12 verified source groups under the default 20-group limit');
  assert.match(await page.locator('.holder-highlight-card').innerText(), /نمایش ۱۲ نماد از ۱۲ نماد/);
  assert.equal(await page.locator('.highlights-panel .scan-error').count(), 0);
  assert.deepEqual(errors, []);
  console.log(`PASS UI highlights: ${EXPECTED} dated prices/volume/value, no expensive Worker requests; holder stage deferred; clientType/floor remain unknown.`);

  // Second refresh: one whole 8-symbol batch loses BOTH source endpoints.
  // Its prior dated records must survive, marked explicitly as previous data.
  brokenSymbols = new Set(defaultSymbols.slice(-8).map(toApiSymbol));
  await page.getByRole('button', { name: /بروزرسانی رتبه‌بندی‌ها/ }).click();
  await page.waitForFunction(() => {
    const panel = document.querySelector('.highlights-panel');
    return (panel?.querySelector('[role="status"]')?.textContent ?? '').includes('دادهٔ قبلی ۸')
      && (panel?.querySelector('button.primary-button')?.textContent ?? '').includes('بروزرسانی رتبه‌بندی‌ها');
  }, null, { timeout: 90_000 });
  const retainedCoverage = await page.locator('.highlights-panel [role="status"]').first().innerText();
  assert.match(retainedCoverage, /قیمت تاریخ‌دار ۱۷۸/);
  assert.match(retainedCoverage, /دادهٔ قبلی ۸/);
  assert.equal(await page.locator('.highlights-intro').getByText(/پوشش قیمت، حجم یا ارزش معاملات کامل نیست/).count(), 1,
    'retained cached prices must be explicitly marked as partial coverage');
  assert.ok(workerBatches > 0, 'broken direct-source batch must try Worker fallback');
  assert.match(await page.locator('.notice-copy').innerText(), /۱۷۰ نماد.*تازه دریافت/);
  assert.equal(await page.locator('.highlights-panel .scan-error').count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS UI highlights: partial 503 refresh retains 8 dated cached rows and reports 170 freshly received symbols.');

  // A Thursday-traded commodity ETF must not suppress 177 ordinary stocks
  // whose confirmed latest normal trading session was Wednesday.
  brokenSymbols = new Set();
  mixedCommoditySession = true;
  await page.getByRole('button', { name: /بروزرسانی رتبه‌بندی‌ها/ }).click();
  await page.waitForFunction(() => (document.querySelector('.highlights-panel .session-date-badge')?.textContent ?? '').includes('۱۴۰۵/۰۷/۲۲')
    && (document.querySelector('.highlights-panel')?.textContent ?? '').includes('چند جلسه معاملاتی'), null, { timeout: 90_000 });
  assert.match(await page.locator('.highlights-intro').innerText(), /۱۷۷ نماد مربوط به جلسه غالب/);
  assert.equal(await page.locator('.highlight-card').first().locator('tbody tr').count(), 10);
  assert.deepEqual(errors, []);
  console.log('PASS UI highlights: mixed Thursday commodity session keeps dominant Wednesday stock rankings separate.');
} catch (error) {
  console.error('UI diagnostics', JSON.stringify({ workerBatches, dailyBatches, snapshotBatches, holderCalls, holderStartPriceBatches,
    coverage: await page.locator('.highlights-panel [role="status"]').first().innerText().catch(() => ''),
    alert: await page.locator('.highlights-panel .scan-error').first().innerText().catch(() => ''), errors }));
  throw error;
} finally { await browser.close(); }
