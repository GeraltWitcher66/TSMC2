import type { ScreenerRow } from "./market";

/** Refresh only while a price screener tab is visible; five minutes avoids
 * flooding the upstream market-data providers while keeping an open page current. */
export const SCREENER_AUTO_REFRESH_INTERVAL_MS = 5 * 60_000;

export function shouldAutoRefreshScreener(tab: string, visible: boolean, loading: boolean) {
  return visible && !loading && (tab === "3m" || tab === "6m");
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
