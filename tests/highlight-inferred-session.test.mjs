import test from 'node:test';
import assert from 'node:assert/strict';
import { inferSnapshotSession } from '../app/lib/market-session.ts';
import { expectedHighlightSession } from '../app/lib/highlight-session.ts';

// Tuesday 2026-11-24, 13:30 Tehran: the equity session has just closed.
const now = new Date('2026-11-24T10:00:00Z');
const maxSession = expectedHighlightSession('خودرو', now);
const dailyRows = [{ d_even: 20261123, open: 770, high: 790, low: 768, close: 781, last: 781, yesterday: 760, volume: 5_000_000, value: 3_800_000_000 }];
const snapshot = {
  Name: 'خودرو', Date: 0, PriceYesterday: 781, PriceFirst: 790, PriceMin: 780,
  PriceMax: 820, PriceClose: 815, PriceLast: 815, Volume: 1_200_000, TradeCount: 3_500, Value: 970_000_000, Time: 123000,
};

test('undated snapshot whose previous close matches the last daily row gets the next trading session', () => {
  assert.equal(maxSession, 20261124);
  assert.equal(inferSnapshotSession(snapshot, dailyRows, maxSession, now), 20261124);
});

test('mismatched PriceYesterday leaves the snapshot session unknown', () => {
  assert.equal(inferSnapshotSession({ ...snapshot, PriceYesterday: 780 }, dailyRows, maxSession, now), null);
});

test('zero-volume snapshot is not dated as a traded session', () => {
  assert.equal(inferSnapshotSession({ ...snapshot, Volume: 0 }, dailyRows, maxSession, now), null);
});
