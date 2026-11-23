import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptMarketUniverse, holderStatus, holderErrorStatus, mergeMarketUniverse, pendingHolderSymbols, retainHolderOnFailure, releaseProcessingHolders } from '../app/lib/holder-scan-recovery.ts';

test('cancelled in-flight rows return to pending without erasing verified observations', () => {
  const processing = { count: null, status: 'processing', sourceDate: null, retrievedAt: null, delivery: 'source', partial: false };
  const verified = { count: 6, status: 'verified', sourceDate: null, retrievedAt: 111, delivery: 'source', partial: false };
  const prior = { 'فنر': verified, 'کسرام': processing };
  const stopped = releaseProcessingHolders(prior);
  assert.equal(stopped['کسرام'].status, 'pending');
  assert.equal(stopped['کسرام'].count, null);
  assert.equal(stopped['فنر'], verified, 'verified result remains untouched');
  assert.equal(prior['کسرام'].status, 'processing', 'input remains immutable');
});

test('660 valid instruments with partial=true remain eligible for scanning', () => {
  const symbols = Array.from({ length: 660 }, (_, i) => ({ symbol: `نماد${String(i + 1).padStart(3, '0')}`, name: `شرکت ${i + 1}`, market: 'بورس' }));
  const partial = acceptMarketUniverse({ symbols, partial: true });
  assert.equal(partial.partial, true);
  assert.equal(partial.symbols.length, 660);
  assert.equal(new Set(partial.symbols.map((r) => r.symbol)).size, 660);
  assert.equal(pendingHolderSymbols(partial.symbols.map((r) => r.symbol), {}, { now: 10000, expectedSession: 20261014, maxAgeMs: 1000 }).length, 660);
  assert.equal(acceptMarketUniverse({ symbols, partial: false }).symbols.length, 660);
  assert.equal(acceptMarketUniverse({ symbols: [], partial: true }).symbols.length, 0);
  assert.equal(acceptMarketUniverse({ symbols: [{ symbol: '' }, { symbol: '12345' }, symbols[0], symbols[0]], partial: true }).symbols.length, 1);
});

test('verified zero, failure, timeout and unavailable outcomes stay distinguishable', () => {
  assert.equal(holderStatus(12), 'verified');
  assert.equal(holderStatus(0), 'verified-zero');
  assert.equal(holderStatus(null), 'unavailable');
  assert.equal(holderStatus(-1), 'unavailable');
  assert.equal(holderErrorStatus(new DOMException('deadline', 'TimeoutError')), 'timeout');
  assert.equal(holderErrorStatus(new Error('network error')), 'failed');
});

test('resume skips verified rows, retries outstanding rows, and invalidates older sessions', () => {
  const now = 100000;
  const make = (count, status, checkedSession = 20261014) => ({ count, status, sourceDate: null, retrievedAt: now - 100, checkedSession, delivery: 'source', partial: false });
  const prior = {
    A: make(12, 'verified'), B: make(0, 'verified-zero'),
    C: make(null, 'failed'), D: make(null, 'timeout'), E: make(null, 'unavailable'),
  };
  const options = { now, expectedSession: 20261014, maxAgeMs: 10000 };
  assert.deepEqual(pendingHolderSymbols(['A', 'B', 'C', 'D', 'E', 'F'], prior, options), ['C', 'D', 'E', 'F']);
  assert.deepEqual(pendingHolderSymbols(['A', 'B'], prior, options), []);
  assert.deepEqual(pendingHolderSymbols(['A', 'B'], prior, { ...options, expectedSession: 20261015 }), ['A', 'B']);
  assert.deepEqual(pendingHolderSymbols(['A', 'B'], prior, { ...options, now: now + 11000 }), ['A', 'B']);
  assert.deepEqual(pendingHolderSymbols(['A', 'B'], prior, { ...options, force: true }), ['A', 'B']);
});

test('failed or invalid refresh retains the verified count, observation date, and provenance', () => {
  const prior = { count: 14, status: 'verified', sourceDate: 20261013, retrievedAt: 12345, checkedSession: 20261014, delivery: 'source', partial: false };
  const cached = retainHolderOnFailure(prior, 'invalid-source', 23456, 20261015);
  assert.equal(cached.count, 14);
  assert.equal(cached.status, 'verified');
  assert.equal(cached.sourceDate, 20261013);
  assert.equal(cached.retrievedAt, 12345);
  assert.equal(cached.checkedSession, 20261014);
  assert.equal(cached.delivery, 'cache');
  assert.equal(cached.partial, true);
  assert.equal(cached.lastRefreshFailure, 'invalid-source');
  assert.equal(cached.lastRefreshAttemptAt, 23456);
  assert.equal(prior.delivery, 'source', 'previous verified record must be immutable');
  assert.deepEqual(pendingHolderSymbols(['A'], { A: cached }, { now: 23457, expectedSession: 20261014, maxAgeMs: 100000 }), ['A'], 'a retained cached count still needs a retry');
  const recovered = { ...prior, count: 15, status: 'verified', sourceDate: 20261015, retrievedAt: 23458, checkedSession: 20261015, delivery: 'source' };
  assert.deepEqual(pendingHolderSymbols(['A'], { A: recovered }, { now: 23459, expectedSession: 20261015, maxAgeMs: 100000 }), []);
});

test('verified zero is retained on HTTP timeout, but unknown counts remain failed', () => {
  const priorZero = { count: 0, status: 'verified-zero', sourceDate: null, retrievedAt: 100, checkedSession: 20261014, delivery: 'source', partial: false };
  const savedZero = retainHolderOnFailure(priorZero, 'timeout', 200, 20261015);
  assert.equal(savedZero.count, 0);
  assert.equal(savedZero.status, 'verified-zero');
  assert.equal(savedZero.delivery, 'cache');
  assert.equal(retainHolderOnFailure(undefined, 'failed', 200, 20261015).count, null);
  assert.equal(retainHolderOnFailure({ ...priorZero, status: 'verified', count: null }, 'invalid-source', 200, 20261015).status, 'invalid-source');
});

test('partial universe retry merges by symbol identity without dropping old IDs', () => {
  const first = acceptMarketUniverse({ partial: true, symbols: [
    { symbol: 'كگل', name: 'old', market: 'بورس' },
    { symbol: 'فولاد', name: 'oldName', market: 'بورس' },
  ] });
  const retry = acceptMarketUniverse({ partial: true, symbols: [
    { symbol: 'کگل', name: 'new', market: '' },
    { symbol: 'شستا', name: 'newSymbol', market: 'بورس' },
  ] });
  const merged = mergeMarketUniverse(first.symbols, retry.symbols);
  assert.deepEqual(merged.symbols.map(({ symbol }) => symbol), ['کگل', 'فولاد', 'شستا']);
  assert.equal(merged.retained, 1);
  assert.equal(merged.symbols[0].name, 'new');
  assert.equal(merged.symbols[0].market, 'بورس');
  const complete = mergeMarketUniverse(merged.symbols, [
    { symbol: 'کگل', name: 'new', market: 'بورس' },
    { symbol: 'فولاد', name: 'new', market: 'بورس' },
    { symbol: 'شستا', name: 'new', market: 'بورس' },
  ]);
  assert.equal(complete.retained, 0);
  assert.equal(complete.symbols.length, 3);
});
