import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { defaultSymbols } from '../app/default-symbols.ts';

const expected = defaultSymbols.length;
const daily = Array.from({ length: 210 }, (_, i) => {
  const date = new Date(Date.UTC(2026, 9, 14) - (209 - i) * 86400000);
  return { d_even: date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate(),
    close: 5000 + i * 9, high: 5100 + i * 9, low: 4900 + i * 9, last: 5000 + i * 9 };
});
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
const calls = { worker: 0, directHistory: 0, directInstruments: 0 };
page.on('pageerror', (error) => errors.push(error.message));

try {
  await context.addInitScript((symbols) => {
    localStorage.setItem('ss-haghighi-v1', JSON.stringify(symbols));
    localStorage.setItem('ss-active-source-v1', 'haghighi');
  }, defaultSymbols);
  await context.route('https://zarvanfund.ir/api/**', async (route) => {
    const url = new URL(route.request().url());
    const symbols = (url.searchParams.get('syms') ?? '').split(',').filter(Boolean);
    if (url.pathname.endsWith('/daily-batch')) {
      calls.directHistory++;
      await route.fulfill({ json: Object.fromEntries(symbols.map((symbol) => [symbol, daily])), headers: { 'access-control-allow-origin': '*' } });
    } else if (url.pathname.endsWith('/instruments')) {
      calls.directInstruments++;
      await route.fulfill({ json: Object.fromEntries(symbols.map((symbol) => [symbol, { Name: symbol }])), headers: { 'access-control-allow-origin': '*' } });
    } else await route.fulfill({ status: 404, body: 'not mocked' });
  });
  await context.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'zarvanfund.ir') return route.fallback();
    if (url.pathname === '/api/screener') {
      calls.worker++;
      await route.fulfill({ status: 503, contentType: 'text/html', body: '<html>upstream 503</html>' });
    } else await route.fulfill({ json: {} });
  });

  await page.goto(process.env.SITE_TEST_URL || 'http://127.0.0.1:3189/', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  try {
    await page.waitForFunction((count) => {
      const rows = [...document.querySelectorAll('tbody tr')];
      return rows.length === count && rows.every((row) => row.querySelectorAll('td').length >= 9 && row.textContent.includes('۱۴۰۵'));
    }, expected, { timeout: 35_000 });
  } catch (error) {
    console.error('Browser diagnostics', JSON.stringify({ calls, errors, rows: await page.locator('tbody tr').count(),
      first: (await page.locator('tbody tr').first().innerText().catch(() => '')).slice(0, 300),
      status: (await page.locator('.session-state').innerText().catch(() => '')).slice(0, 350) }));
    throw error;
  }
  assert.equal(await page.locator('tbody tr').count(), expected, 'all stocks must survive mocked HTML 503');
  const first90 = await page.locator('tbody tr').first().innerText();
  assert.doesNotMatch(first90, /HTTP 503/);
  // On a remote Workers deployment the server-rendered welcome button may
  // be clicked before React hydration. Once table data proves hydration has
  // completed, dismiss the dialog again if the early click was not bound.
  if (await page.locator('.welcome-modal').isVisible()) {
    await page.getByRole('button', { name: 'ورود به برنامه', exact: true }).click();
  }
  await page.locator('.welcome-modal').waitFor({ state: 'detached', timeout: 8000 });
  await page.getByRole('button', { name: /فیلتر ۱۸۰ روزه/ }).click();
  assert.equal(await page.locator('tbody tr').count(), expected);
  const first180 = await page.locator('tbody tr').first().innerText();
  assert.doesNotMatch(first180, /HTTP 503/);
  // One 503 followed by successful dated CORS recovery avoids further Worker
  // calls in this refresh (17 remaining batches), not 8 more failing probes.
  assert.equal(calls.worker, 1);
  assert.equal(calls.directHistory, Math.ceil(expected / 10));
  assert.equal(calls.directInstruments, Math.ceil(expected / 10));
  assert.deepEqual(errors, []);
  console.log(`PASS browser: ${expected} symbols with HTML 503 recovered in both 90/180 tables; ${calls.worker} Worker probes and ${calls.directHistory} bounded direct batches.`);
} finally {
  await browser.close();
}
