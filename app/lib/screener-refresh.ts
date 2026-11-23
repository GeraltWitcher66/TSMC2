import type { ScreenerRow } from "./market";
import { lastClosedEquitySession } from "./market-session";
import { screenerQuoteSession } from "./screener-freshness";

/** A failed official-verification pass is retried at most this often ... */
export const SCREENER_VERIFICATION_RETRY_MS = 10 * 60_000;
/** ... and this many times for one expected session. Manual refresh ignores both. */
export const SCREENER_MAX_VERIFICATION_ATTEMPTS = 3;
/** The Tehran cash session closes at 13:00; a short grace covers the source. */
const TEHRAN_CLOSE_MINUTE = 13 * 60 + 5;
const TEHRAN = "Asia/Tehran";

export type ScreenerVerificationState = {
  /** Expected session the attempts belong to. */
  session: number;
  attempts: number;
  lastAttemptAt: number;
};

export type ScreenerRefreshContext = {
  /** Session of the rows currently on screen (from their own dated quotes). */
  loadedSession?: number | null;
  verification?: ScreenerVerificationState | null;
};

type TehranClock = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

function tehranClock(now: Date): TehranClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TEHRAN, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const v = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const calendar = new Date(Date.UTC(Number(v.year), Number(v.month) - 1, Number(v.day)));
  return { year: Number(v.year), month: Number(v.month), day: Number(v.day), hour: Number(v.hour), minute: Number(v.minute), weekday: calendar.getUTCDay() };
}

/** Tehran has no DST; the offset is still read from Intl so the instant stays exact. */
function tehranOffsetMs(instant: Date) {
  const clock = tehranClock(instant);
  const wallAsUtc = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute);
  return wallAsUtc - Math.floor(instant.getTime() / 60_000) * 60_000;
}

function fromTehranWall(year: number, month: number, day: number, hour: number, minute: number) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(guess - tehranOffsetMs(new Date(guess)));
}

/** Latest dated session present in the rows, or null when no row is dated. */
export function screenerRowsSession(rows: ScreenerRow[], now = new Date()): number | null {
  let latest: number | null = null;
  for (const row of rows) {
    const session = screenerQuoteSession(row, now);
    if (session && (latest === null || session > latest)) latest = session;
  }
  return latest;
}

/** The official source itself answered with an older session for this symbol
 * (halted or not traded), so a new attempt cannot make it newer. */
export function screenerRowSettled(row: ScreenerRow, expectedSession: number, now = new Date()) {
  const session = screenerQuoteSession(row, now);
  return session !== null && session < expectedSession;
}

export function screenerRowNeedsVerification(row: ScreenerRow, expectedSession: number, now = new Date()) {
  if (row.quoteVerified === true) return false;
  return !screenerRowSettled(row, expectedSession, now);
}

export function screenerPendingVerification(rows: ScreenerRow[], expectedSession = lastClosedEquitySession(), now = new Date()) {
  return rows.filter((row) => screenerRowNeedsVerification(row, expectedSession, now));
}

/**
 * Whether the visible list still has a reason to touch the network.
 * - nothing loaded yet;
 * - the expected session moved past the session of the data on screen;
 * - some row is still verifiable for the expected session, the last automatic
 *   attempt is at least ten minutes old, and fewer than three were made.
 * A symbol whose official source reported an older session (halted/no trade)
 * never triggers another refresh on its own.
 */
export function screenerNeedsRefresh(rows: ScreenerRow[], now = new Date(), context: ScreenerRefreshContext = {}) {
  const expected = lastClosedEquitySession(now);
  const loaded = context.loadedSession ?? null;
  if (!rows.length || loaded === null) return true;
  if (loaded < expected) return true;
  if (!screenerPendingVerification(rows, expected, now).length) return false;
  const state = context.verification;
  if (!state || state.session !== expected) return true;
  if (state.attempts >= SCREENER_MAX_VERIFICATION_ATTEMPTS) return false;
  return now.getTime() - state.lastAttemptAt >= SCREENER_VERIFICATION_RETRY_MS;
}

/**
 * Next moment the list can legitimately gain a newer closing session: the
 * following Saturday–Wednesday session at 13:05 Tehran. Thursday/Friday and a
 * still-running session never produce an earlier refresh.
 */
export function nextScreenerRefreshAt(now = new Date()) {
  const clock = tehranClock(now);
  const isClosedWeekday = (weekday: number) => weekday === 4 || weekday === 5;
  const today = fromTehranWall(clock.year, clock.month, clock.day, Math.floor(TEHRAN_CLOSE_MINUTE / 60), TEHRAN_CLOSE_MINUTE % 60);
  if (!isClosedWeekday(clock.weekday) && today.getTime() > now.getTime()) return today;
  const cursor = new Date(Date.UTC(clock.year, clock.month - 1, clock.day));
  do { cursor.setUTCDate(cursor.getUTCDate() + 1); } while (isClosedWeekday(cursor.getUTCDay()));
  return fromTehranWall(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, cursor.getUTCDate(), Math.floor(TEHRAN_CLOSE_MINUTE / 60), TEHRAN_CLOSE_MINUTE % 60);
}

/** Keep the last verified prices, but make a failed refresh visibly stale. */
export function markScreenerRowsStale(rows: ScreenerRow[], reason: string): ScreenerRow[] {
  return rows.map((row) => {
    const date = Number(row.priceQuote?.sessionDate ?? row.three?.currentDate ?? row.six?.currentDate ?? 0);
    const dateLabel = date ? `آخرین جلسه معتبر ${date} است.` : "تاریخ معتبر آخرین داده مشخص نیست.";
    return {
      ...row,
      status: row.status === "error" ? "error" : "warning",
      note: `${reason} ${dateLabel}${row.note ? ` ${row.note}` : ""}`,
    };
  });
}
