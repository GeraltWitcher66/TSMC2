// Browser-level regression for the divergence column and evidence modal.
// The OHLC feed here is synthetic; this does not assert a real-market signal.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { analyzeDivergence } from '../app/lib/divergence.ts';
import { divergenceSeries, asOf } from './helpers/divergence-series.mjs';

const candles = divergenceSeries();
const analysis = analyzeDivergence(candles, [], 90, { now: asOf(candles) });
assert.equal(analysis.divergence?.code, 'RD+');
const metric = { startDate: 20260401, currentDate: 20260626, peakDate: 20260615,
  startPrice: 100, peakPrice: 120, currentPrice: 86, drawdownPct: 28.3, returnPct: -14 };
const row = { symbol: 'اوان', name: 'نماد آزمایشی اوان', realHolders: null, rsi: analysis.rsi,
  three: metric, six: metric, actions: [], status: 'ready', quoteVerified: true,
  divergence: analysis.divergence, divergenceAnalysis: analysis };

const browser = await chromium.launch({ headless: true, channel: 'msedge' });
try {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem('ss-custom-v1', JSON.stringify(['اوان']));
    localStorage.setItem('ss-active-source-v1', 'custom');
  });
  await context.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/screener') return route.fulfill({ json: { rows: [row], latestDate: 20260626, fetchedAt: '2026-06-26T10:00:00Z' } });
    return route.fulfill({ json: { rows: [], sourceDate: null, fetchedAt: '2026-06-26T10:00:00Z' } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.SITE_TEST_URL || 'http://127.0.0.1:3187/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1400);
  await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  await page.locator('.modal-backdrop').waitFor({ state: 'detached', timeout: 8000 });
  await page.getByRole('button', { name: 'تحلیل واگرایی اوان' }).waitFor({ timeout: 12000 });
  const control = page.getByRole('button', { name: 'تحلیل واگرایی اوان' });
  assert.match(await control.innerText(), /RD\+/);
  await control.click();
  const dialog = page.locator('dialog.divergence-dialog');
  await dialog.waitFor({ state: 'visible', timeout: 6000 });
  const text = await dialog.innerText();
  assert.match(text, /پیوت اول/);
  assert.match(text, /پیوت دوم/);
  assert.match(text, /واگرایی معمولی مثبت/);
  assert.match(text, /RSI ۱۲ قیمت پایانی/);
  await dialog.locator('details summary').click();
  const rules = await dialog.locator('details').innerText();
  assert.match(rules, /مخفی مثبت/);
  assert.match(rules, /MACD.*محاسبه.*نشده/);
  assert.equal(await dialog.locator('svg[role="img"]').count(), 1);
  assert.deepEqual(errors, []);
  await context.close();
  console.log('PASS divergence UI: distinct RSI bases, RD+ code, two swing dates, diagram, no browser exceptions.');
} finally { await browser.close(); }
