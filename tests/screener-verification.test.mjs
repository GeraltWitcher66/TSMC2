import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserQuoteClient } from '../app/lib/browser-quotes.ts';
import { preserveVerifiedRows } from '../app/lib/screener-freshness.ts';
import { lastClosedEquitySession } from '../app/lib/market-session.ts';
import { withDeadline } from '../app/lib/request-lifecycle.ts';
import { divergenceSeries } from './helpers/divergence-series.mjs';

const expectedSession = lastClosedEquitySession();

const sourceRow = (symbol = 'الف', insCode = '1') => {
  const candles = divergenceSeries();
  return {
    symbol, insCode, rsi: null, realHolders: null, actions: [], three: null, six: null,
    status: 'warning', quoteVerified: false,
    analysisInput: { candles, changes: [], eps: 10, pe: 10, sectorPe: 12 },
  };
};

const verifiedRow = (symbol = 'الف', insCode = '1') => ({
  ...sourceRow(symbol, insCode),
  quoteVerified: true,
  status: 'ready',
  priceQuote: { closeRial: 86, sessionDate: expectedSession },
  divergenceAnalysis: { status: 'none' },
});

test('a refresh that loses official confirmation keeps the verified row of the same session', () => {
  const verified = new Map();
  const confirmed = verifiedRow();
  const first = preserveVerifiedRows([confirmed], verified, expectedSession);
  assert.equal(first[0], confirmed);
  assert.equal(verified.size, 1);

  // The second refresh returns only the unverified base row for that session.
  const unverified = {
    ...sourceRow(),
    quoteVerified: false,
    status: 'warning',
    priceQuote: { closeRial: 87, sessionDate: expectedSession },
  };
  const second = preserveVerifiedRows([unverified], verified, expectedSession);
  assert.equal(second[0], confirmed, 'the confirmed price must survive an unverified refresh');
  assert.equal(second[0].quoteVerified, true);
  assert.equal(second[0].status, 'ready');
  assert.equal(second[0].priceQuote.closeRial, 86);

  // A verified row for an older session must be re-verified once the expected
  // session has moved on, so the fresh unverified row is used instead.
  const staleMap = new Map();
  preserveVerifiedRows([{ ...verifiedRow(), priceQuote: { closeRial: 80, sessionDate: 20200101 } }], staleMap, expectedSession);
  const advanced = preserveVerifiedRows([unverified], staleMap, expectedSession);
  assert.equal(advanced[0], unverified);

  // A newer verified row replaces the older confirmed one.
  const newer = { ...verifiedRow(), priceQuote: { closeRial: 91, sessionDate: expectedSession } };
  assert.equal(preserveVerifiedRows([newer], verified, expectedSession)[0], newer);
});

const officialPayload = () => Response.json({
  closingPriceInfo: {
    dEven: expectedSession, priceMax: 121, priceMin: 119, pClosing: 120,
    pDrCotVal: 120, priceFirst: 120, priceYesterday: 119, qTotTran5J: 10,
  },
});

test('a verification deadline keeps every confirmed row and the rest complete in a quiet background pass', async () => {
  const slow = async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return String(url).includes('GetClosingPriceInfo') ? officialPayload() : Response.json({ closingPriceDaily: [] });
  };
  const client = createBrowserQuoteClient(slow);
  const rows = Array.from({ length: 40 }, (_, index) => sourceRow(`S${index}`, String(index + 1)));
  const published = [];

  await assert.rejects(withDeadline(
    (signal) => client.refresh(rows, () => !signal.aborted, signal, (snapshot) => published.push(snapshot), { concurrency: 4 }),
    120,
  ));

  const atDeadline = published.at(-1);
  const confirmedBeforeDeadline = atDeadline.filter((row) => row.quoteVerified === true).length;
  assert.equal(atDeadline.length, 40, 'progress snapshots describe the whole list');
  assert.ok(confirmedBeforeDeadline > 0, 'rows confirmed before the deadline must already be published');
  assert.ok(confirmedBeforeDeadline < 40, 'the deadline must interrupt the remaining rows');

  const pending = atDeadline.filter((row) => row.quoteVerified !== true);
  await client.refresh(pending, () => true, undefined, (snapshot) => published.push(snapshot), { concurrency: 2 });
  const confirmedLater = published.at(-1).filter((row) => row.quoteVerified === true).length;

  assert.equal(pending.length, 40 - confirmedBeforeDeadline);
  assert.equal(confirmedBeforeDeadline + confirmedLater, 40, 'the quiet pass completes the rest');
});
