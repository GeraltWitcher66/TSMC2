import { isThursdayCommodityInstrument, sourceSession } from "./market-session";

export { isThursdayCommodityInstrument };

/** Expected *closed* session for a highlight instrument in Tehran time.
 * Since 1405/07/09 (2026-10-01) some commodity products trade Thursdays.
 * This is only a freshness warning / fallback criterion; the source must
 * still provide its own date before a quote can be ranked. */
export function expectedHighlightSession(name: string, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const p = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day)));
  const commodity = isThursdayCommodityInstrument(name);
  const compact = (d: Date) => d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
  const trading = (d: Date) => d.getUTCDay() !== 5 && (d.getUTCDay() !== 4 || (commodity && compact(d) >= 20261001));
  const closingHour = day.getUTCDay() === 4 && commodity ? 16 : 13;
  if (trading(day) && Number(p.hour) >= closingHour) return compact(day);
  do { day.setUTCDate(day.getUTCDate() - 1); } while (!trading(day));
  return compact(day);
}

/** Do not allow a handful of Thursday-traded ETFs to suppress all Wednesday
 * stock rankings: choose the most covered dated session, newest on ties. */
export function primaryHighlightSession<T extends { sessionDate?: number | null }>(rows: T[]) {
  const counts = new Map<number, number>();
  for (const row of rows) {
    const date = sourceSession(row.sessionDate);
    if (date) counts.set(date, (counts.get(date) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? null;
}
