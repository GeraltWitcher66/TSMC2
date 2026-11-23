import type { ScreenerRow } from "./market";
import { sourceSession } from "./market-session";

/** Validated *source* date, not the time when the request completed. */
export function screenerQuoteSession(row: ScreenerRow, now = new Date()): number | null {
  const quote = row.priceQuote;
  if (quote) return Number.isFinite(quote.closeRial) && quote.closeRial > 0
    ? sourceSession(quote.sessionDate, now) : null;
  const period = row.three ?? row.six;
  return period && Number.isFinite(period.currentPrice) && period.currentPrice > 0
    ? sourceSession(period.currentDate, now) : null;
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
