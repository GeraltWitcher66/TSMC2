// A Worker HTTP 200 without usable dated prices is not a successful screener.
// Use the same 10-symbol bounded CORS recovery as HTTP 503; avoid repeated
// empty Worker invocations for the rest of this refresh. All responses mocked.
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { defaultSymbols } from '../app/default-symbols.ts';

const symbols = defaultSymbols.slice(0, 25);
const raw = Array.from({ length: 260 }, (_, i) => {
  const date = new Date(Date.UTC(2026, 9, 28) - i * 86400_000);
  return { d_even: Number(date.toISOString().slice(0, 10).replaceAll('-', '')), close: 1000, high: 1020, low: 980, yesterday: 1000 };
});
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext();
const page = await context.newPage();
const calls = { worker: 0, instruments: 0, history: 0 };
const errors = [];
page.on('pageerror', e => errors.push(e.message));
try {
  await context.addInitScript(s => {
    localStorage.setItem('ss-haghighi-v1', JSON.stringify(s));
    localStorage.setItem('ss-active-source-v1', 'haghighi');
  }, symbols);
  await context.route('https://zarvanfund.ir/api/**', route => {
    const url = new URL(route.request().url());
    const batch = decodeURIComponent(url.searchParams.get('syms') ?? '').split(',').filter(Boolean);
    assert.ok(batch.length <= 10, 'client may not expand batch size');
    if (url.pathname.endsWith('/daily-batch')) {
      calls.history++;
      return route.fulfill({ json: Object.fromEntries(batch.map(s => [s, raw])), headers: { 'access-control-allow-origin': '*' } });
    }
    calls.instruments++;
    return route.fulfill({ json: Object.fromEntries(batch.map(s => [s, { Name: s }])), headers: { 'access-control-allow-origin': '*' } });
  });
  await context.route('**/api/**', route => {
    const url = new URL(route.request().url());
    if (url.hostname === 'zarvanfund.ir') return route.fallback();
    if (url.pathname === '/api/screener') {
      calls.worker++;
      return route.fulfill({ json: { rows: route.request().postDataJSON()?.symbols.map(symbol => ({
        symbol, rsi: null, realHolders: null, three: null, six: null, actions: [], status: 'error', note: 'upstream empty',
      })) ?? [], partial: true, latestDate: null } });
    }
    return route.fulfill({ json: {} });
  });
  await page.goto(process.env.SITE_TEST_URL || 'http://127.0.0.1:3189/', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(n => document.querySelectorAll('tbody tr').length === n &&
    [...document.querySelectorAll('tbody tr')].every(row => row.querySelectorAll('td').length >= 9), symbols.length, { timeout: 45_000 });
  assert.equal(await page.locator('tbody tr').count(), symbols.length);
  assert.equal(calls.worker, 1, 'do not request the same blank Worker for the rest of the list');
  assert.equal(calls.history, Math.ceil(symbols.length / 10));
  assert.equal(calls.instruments, Math.ceil(symbols.length / 10));
  assert.deepEqual(errors, []);
  console.log(`PASS 200-empty Worker -> ${calls.history} date-preserving direct batches; only ${calls.worker} Worker request.`);
} finally { await browser.close(); }
