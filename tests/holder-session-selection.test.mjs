import test from 'node:test';
import assert from 'node:assert/strict';
import { lastClosedEquitySession, selectHolderSession, holderSessionCoverage } from '../app/lib/market-session.ts';
import { latestNonFutureDate, extractMajorIndividualHoldingChanges } from '../app/lib/market.ts';
import { validateHolderChangesPayload } from '../app/lib/holder-increases-source.ts';

// Oct 15 2026 is Thursday: Tehran equity market last closed Wed Oct 14.
const thursday = new Date('2026-10-15T16:49:00Z');
const friday = new Date('2026-10-16T16:49:00Z');
const saturdayMorning = new Date('2026-10-17T08:29:00Z'); // 11:59 Tehran
const saturdayClosed = new Date('2026-10-17T10:00:00Z'); // 13:30 Tehran
const dates = [20261011, 20261012, 20261013, 20261014, 20261015];
const source = {
  dates,
  shareHoldersChanges: [{ name: 'شخص حقیقی', insList: [
    { insCode: 'A', name: 'غگل', firstDay: 100, secondDay: 110, thirdDay: 120, fourthDay: 150, fifthDay: 999 },
    { insCode: 'B', name: 'غشهر', firstDay: 200, secondDay: 200, thirdDay: 200, fourthDay: 200, fifthDay: 500 },
  ] }],
};

test('selection, validation, coverage and extraction agree on last CLOSED ordinary-equity session on Thursday', () => {
  assert.equal(lastClosedEquitySession(thursday), 20261014);
  assert.equal(latestNonFutureDate(dates, thursday), 20261014);
  assert.deepEqual(selectHolderSession(dates, thursday), {
    sourceDate: 20261014, index: 3, previousIndex: 2, completeForSelectedSession: false,
  });
  assert.deepEqual(holderSessionCoverage(source, thursday), { sourceDate: 20261014, completeForSelectedSession: false });
  assert.equal(validateHolderChangesPayload(source, thursday), true, 'partial source remains usable for explicit positive changes');
  const rows = extractMajorIndividualHoldingChanges(source, { now: thursday });
  assert.deepEqual(rows.map(row => [row.insCode, row.date, row.previousShares, row.currentShares, row.changeShares]),
    [['A', 20261014, 120, 150, 30]]);
  assert.equal(rows.some(row => row.insCode === 'B'), false, 'unconfirmed Thursday growth is never attributed to Wednesday');
});

test('precreated Friday and Thursday slots remain partial; Saturday equity session only closes at 13:00 Tehran', () => {
  const withFriday = { ...source, dates: [20261012, 20261013, 20261014, 20261015, 20261016] };
  for (const now of [thursday, friday, saturdayMorning]) {
    assert.equal(lastClosedEquitySession(now), 20261014);
    assert.equal(latestNonFutureDate(withFriday.dates, now), 20261014);
    assert.equal(holderSessionCoverage(withFriday, now).completeForSelectedSession, false);
    assert.equal(validateHolderChangesPayload(withFriday, now), true);
    assert.ok(extractMajorIndividualHoldingChanges(withFriday, { now }).every(row => row.date === 20261014));
  }
  assert.equal(lastClosedEquitySession(saturdayClosed), 20261017);
  const saturday = {
    ...source, dates: [20261012, 20261013, 20261014, 20261015, 20261017],
  };
  assert.equal(holderSessionCoverage(saturday, saturdayClosed).sourceDate, 20261017);
  assert.equal(holderSessionCoverage(saturday, saturdayClosed).completeForSelectedSession, false,
    'a skipped Thursday snapshot cannot establish a complete Saturday comparison');
  const rows = extractMajorIndividualHoldingChanges(saturday, { now: saturdayClosed });
  assert.ok(rows.some(row => row.insCode === 'A' && row.date === 20261017 && row.previousShares === 120),
    'compare Saturday with the Wednesday thirdDay slot, not the unconfirmed Thursday fourthDay slot');
});

test('without a previous valid equity slot, precreated Thursday slot cannot produce an invented current result', () => {
  const incomplete = { ...source, dates: [20261014, 20261015] };
  assert.equal(validateHolderChangesPayload(incomplete, thursday), false);
  assert.equal(holderSessionCoverage(incomplete, thursday).completeForSelectedSession, false);
  assert.deepEqual(extractMajorIndividualHoldingChanges(incomplete, { now: thursday }), []);
});

test('Thursday commodity trades in mixed holder feed remain explicitly unknown pending instrument-specific proof', () => {
  const commodity = {
    dates: [20261013, 20261014, 20261015],
    shareHoldersChanges: [{ name: 'شخص حقیقی', insList: [
      { insCode: 'GOLD', name: 'صندوق سرمایه گذاری طلای نمونه', firstDay: 80, secondDay: 80, thirdDay: 100 },
    ] }],
  };
  assert.equal(latestNonFutureDate(commodity.dates, thursday), 20261014);
  assert.equal(holderSessionCoverage(commodity, thursday).completeForSelectedSession, false);
  assert.equal(validateHolderChangesPayload(commodity, thursday), true);
  assert.deepEqual(extractMajorIndividualHoldingChanges(commodity, { now: thursday }), []);
  // Genuine Thursday commodity changes require a separate instrument-specific
  // session proof. Do not fabricate a zero or promote one in this mixed feed.
});

test('a date-final, valid Wed equity slot is complete for that snapshot, with no inferred Thursday trade', () => {
  const dated = { ...source, dates: [20261013, 20261014] };
  assert.equal(validateHolderChangesPayload(dated, thursday), true);
  assert.equal(holderSessionCoverage(dated, thursday).completeForSelectedSession, true);
  assert.equal(latestNonFutureDate(dated.dates, thursday), 20261014);
});
