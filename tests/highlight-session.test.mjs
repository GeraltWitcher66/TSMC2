import test from 'node:test';
import assert from 'node:assert/strict';
import { expectedHighlightSession, isThursdayCommodityInstrument, primaryHighlightSession } from '../app/lib/highlight-session.ts';

const thursday = new Date('2026-10-15T12:30:00.000Z'); // 16:00 Tehran
test('ordinary shares and real-estate funds must not be classified as Thursday commodity instruments', () => {
  for (const name of ['سایپا دیزل', 'صندوق س خانه آگاه-املاک', 'سیمان باقران']) {
    assert.equal(isThursdayCommodityInstrument(name), false, name);
    assert.equal(expectedHighlightSession(name, thursday), 20261014, name);
  }
});
test('dated Thursday commodity session is expected only once its session is closed', () => {
  for (const name of ['صندوق س.کالای آبان', 'صندوق س.کالای دنای زاگرس', 'صندوق سرمایه گذاری طلای نمونه']) {
    assert.equal(isThursdayCommodityInstrument(name), true, name);
    assert.equal(expectedHighlightSession(name, thursday), 20261015, name);
    assert.equal(expectedHighlightSession(name, new Date('2026-10-15T10:30:00.000Z')), 20261014, name);
    assert.equal(expectedHighlightSession(name, new Date('2026-10-16T12:00:00.000Z')), 20261015, name);
  }
});
test('session ranking uses dominant source date instead of suppressing ordinary shares after an ETF Thursday trade', () => {
  const rows = [
    { sessionDate: 20261014 }, { sessionDate: 20261014 }, { sessionDate: 20261014 },
    { sessionDate: 20261015 }, { sessionDate: null },
  ];
  assert.equal(primaryHighlightSession(rows), 20261014);
  assert.equal(primaryHighlightSession([{ sessionDate: 20261014 }, { sessionDate: 20261015 }]), 20261015);
  assert.equal(primaryHighlightSession([{ sessionDate: null }, { sessionDate: 20281015 }]), null);
});
