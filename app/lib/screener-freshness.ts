import { normalizeSymbol, type ScreenerRow } from "./market";
import { lastClosedEquitySession, sourceSession } from "./market-session";

/** Validated *source* date, not the time when the request completed. */
export function screenerQuoteSession(row: ScreenerRow, now = new Date()): number | null {
  const quote = row.priceQuote;
  if (quote) return Number.isFinite(quote.closeRial) && quote.closeRial > 0
    ? sourceSession(quote.sessionDate, now) : null;
  const period = row.three ?? row.six;
  return period && Number.isFinite(period.currentPrice) && period.currentPrice > 0
    ? sourceSession(period.currentDate, now) : null;
}

/**
 * A refresh never downgrades an officially verified row of the expected
 * session to an unverified one. `verified` carries the rows that already hold
 * an official quote into the next refresh and is updated with newer ones, so a
 * later refresh that loses official confirmation keeps the confirmed price.
 * Only a newer expected session (or a newer verified row) may replace it.
 */
export function preserveVerifiedRows(
  incoming: ScreenerRow[],
  verified: Map<string, ScreenerRow>,
  expectedSession = lastClosedEquitySession(),
): ScreenerRow[] {
  return incoming.map((row) => {
    const key = normalizeSymbol(row.symbol);
    const previous = verified.get(key);
    if (!previous) {
      if (row.quoteVerified === true) verified.set(key, row);
      return row;
    }
    const previousSession = screenerQuoteSession(previous);
    const rowSession = screenerQuoteSession(row);
    const rowIsNewerVerified = row.quoteVerified === true &&
      (!previousSession || (rowSession !== null && rowSession >= previousSession));
    const previousStillExpected = previousSession !== null && previousSession >= expectedSession;
    if (rowIsNewerVerified || !previousStillExpected) {
      if (row.quoteVerified === true) verified.set(key, row);
      return row;
    }
    return previous;
  });
}

/** Calendar comparison is a caution, not proof that a halted symbol traded. */
export function summarizeScreenerFreshness(rows: ScreenerRow[], calendarSession: number, now = new Date()) {
  let dated = 0, earlierThanCalendar = 0, atCalendar = 0;
  for (const row of rows) {
    const sourceDate = screenerQuoteSession(row, now);
    if (!sourceDate) continue;
    dated++;
    if (sourceDate < calendarSession) earlierThanCalendar++;
    else if (sourceDate === calendarSession) atCalendar++;
  }
  return { requested: rows.length, dated, missing: rows.length - dated,
    atCalendar, earlierThanCalendar, expectedCalendarSession: calendarSession,
    calendarOnly: true as const };
}
