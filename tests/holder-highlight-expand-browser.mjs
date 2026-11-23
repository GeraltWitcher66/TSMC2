// Focused UI regression: an older, scoped backup may contain more than ten
// genuine symbols. Expanding changes ONLY presentation, never source freshness.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { defaultSymbols } from '../app/default-symbols.ts';
import { lastClosedEquitySession } from '../app/lib/market-session.ts';

const sessionDate = lastClosedEquitySession();
const list = defaultSymbols.slice(0, 25);
const raw = {
  d_even: sessionDate, open: 100, high: 113, low: 97, close: 104,
  last: 106, yesterday: 101, volume: 12000, value: 1260000,
};
const holderRows = list.map((symbol, i) => ({
  id: `holder-expansion-${i}`, insCode: String(9000 + i), instrumentName: symbol,
  shareholderType: 'شخص حقیقی', symbol, market: 'بورس',
  previousShares: 500000, currentShares: 500030 - i, changeShares: 30 - i,
  changeEvidence: 'snapshot', date: 20260907, ownershipPct: 1,
}));

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
const errors = [];
let holderCalls = 0;
try {
  await context.addInitScript((symbols) => {
    localStorage.setItem('ss-haghighi-v1', JSON.stringify(symbols));
    localStorage.setItem('ss-active-source-v1', 'haghighi');
  }, list);
  await context.route('https://zarvanfund.ir/api/**', async (route) => {
    const url = new URL(route.request().url());
    const symbols = (url.searchParams.get('syms') ?? '').split(',').filter(Boolean);
    const json = url.pathname.endsWith('/daily-batch')
      ? Object.fromEntries(symbols.map((s) => [s, [raw]]))
      : Object.fromEntries(symbols.map((s, i) => [s, { Name: s, InsCode: String(9000 + i), Date: sessionDate,
        PriceClose: raw.close, PriceLast: raw.last, PriceMax: raw.high, PriceMin: raw.low,
        Volume: raw.volume, Value: raw.value, PriceYesterday: raw.yesterday, PriceFirst: raw.open }]));
    await route.fulfill({ json, headers: { 'access-control-allow-origin': '*' } });
  });
  await context.route('https://cdn.tsetmc.com/**', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'zarvanfund.ir') return route.fallback();
    if (url.pathname === '/api/screener') {
      const symbols = route.request().postDataJSON()?.symbols ?? [];
      return route.fulfill({ json: { rows: symbols.map((symbol) => ({
        symbol, name: symbol, status: 'warning', rsi: null, realHolders: null, actions: [],
        three: { startPrice: 100, peakPrice: 113, currentPrice: 104, currentDate: sessionDate, returnPct: 4, drawdownPct: 8 },
        six: { startPrice: 100, peakPrice: 113, currentPrice: 104, currentDate: sessionDate, returnPct: 4, drawdownPct: 8 },
      })), latestDate: sessionDate } });
    }
    if (url.pathname === '/api/holder-increases') {
      holderCalls++;
      return route.fulfill({ json: { rows: holderRows, sourceDate: 20260907,
        fetchedAt: '2026-09-07T14:00:15.064Z', partial: false, fallback: true,
        delivery: 'bundled', nextCursor: null } });
    }
    if (url.pathname === '/api/tsetmc-relay') return route.fulfill({ status: 503, body: 'unavailable' });
    if (url.pathname === '/api/market-highlights') return route.fulfill({ status: 503, body: 'unavailable' });
    return route.fulfill({ json: { rows: [] } });
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.HIGHLIGHT_TEST_URL || 'http://127.0.0.1:3191/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1300);
  await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 8000 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--navy-950').trim()), '#0c2431');
  await page.getByRole('button', { name: /بیشترین‌های فهرست/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.holder-highlight-card .holder-group-head').length === 20, null, { timeout: 60_000 });
  const card = page.locator('.holder-highlight-card');
  const copy = card.locator('.holder-group-head').first().getByRole('button', { name: `کپی نماد ${list[0]}`, exact: true });
  await copy.click();
  await copy.locator('..').getByRole('status').getByText(/کپی شد/).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), list[0]);
  await copy.locator('..').getByRole('status').getByText(/کپی شد/).waitFor({ state: 'hidden', timeout: 5000 });
  assert.equal(await copy.locator('..').locator('.copy-feedback').innerText(), '', 'copy popup must auto-dismiss');
  assert.equal(await card.locator('.holder-group-head').first().getByRole('button', { name: /شخص حقیقی/ }).getAttribute('aria-expanded'), 'false');
  assert.match(await card.innerText(), /نمایش ۲۰ نماد از ۲۵ نماد/);
  assert.match(await card.innerText(), /نسخه پشتیبان تاریخی/);
  assert.match(await card.innerText(), /زمان ثبت نسخه پشتیبان/);
  const before = holderCalls;
  await page.getByRole('button', { name: /نمایش همه ۲۵ نماد دریافت‌شده/ }).click();
  assert.equal(await card.locator('.holder-group-head').count(), 25);
  await page.getByRole('button', { name: /نمایش ۲۰ نماد برتر/ }).click();
  assert.equal(await card.locator('.holder-group-head').count(), 20);
  assert.equal(holderCalls, before, 'display expansion must not issue another holder network request');
  assert.deepEqual(errors, []);
  console.log('PASS: historical source clearly marked, 20/25 -> 25/25 -> 20/25 without refetch or runtime errors.');
} finally {
  await context.close();
  await browser.close();
}
