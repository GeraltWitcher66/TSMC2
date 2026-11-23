import test from 'node:test';
import assert from 'node:assert/strict';
import { preserveDatedHolderRefresh } from '../app/lib/holder-increase-refresh.ts';

const page = (date, people, opts = {}) => ({ sourceDate: date, fetchedAt: '2026-10-15T15:00:00Z',
  rows: people.map(([id, shares]) => ({ id, date, changeShares: shares })), fallback: false, partial: false, delivery: 'source', ...opts });

test('a newer verified partial official observation is not discarded by older bundled fallback', () => {
  const recent = page(20261015, [['one', 3550000]], { partial: true });
  const old = page(20260907, [['many', 50000000]], { fallback: true });
  const result = preserveDatedHolderRefresh(recent, old);
  assert.equal(result.sourceDate, 20261015);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].id, 'one');
  assert.equal(result.delivery, 'cache');
  assert.equal(result.partial, true);
  assert.equal(result.fetchedAt, recent.fetchedAt);
});

test('same-session partial refresh can add records without erasing earlier verified people', () => {
  const prior = page(20261015, [['one', 100], ['two', 200]], { partial: true });
  const fresh = page(20261015, [['two', 250], ['three', 300]], { partial: true });
  const result = preserveDatedHolderRefresh(prior, fresh);
  assert.equal(result.rows.length, 3);
  assert.deepEqual(result.rows.map(r => r.id), ['one', 'two', 'three']);
  assert.equal(result.rows[1].changeShares, 250);
  assert.equal(result.partial, true);
});

test('new complete session replaces older and complete same-session refresh is authoritative', () => {
  const prior = page(20261014, [['old', 1]]);
  const newest = page(20261015, [['new', 2]], { partial: true });
  assert.equal(preserveDatedHolderRefresh(prior, newest), newest);
  const complete = page(20261015, [['final', 3]]);
  assert.equal(preserveDatedHolderRefresh(newest, complete), complete);
});

test('a fetch without a verified date never overwrites a dated valid observation', () => {
  const prior = page(20261015, [['one', 1]]);
  const blank = page(null, [], { partial: true });
  assert.equal(preserveDatedHolderRefresh(prior, blank).sourceDate, 20261015);
  assert.equal(preserveDatedHolderRefresh(undefined, blank), blank);
});
