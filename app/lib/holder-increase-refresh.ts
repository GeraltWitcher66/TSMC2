/** Preserve source-dated holder observations if a refresh only returns an older
 * bundled/partial snapshot. Never mix people from different source sessions. */
export function preserveDatedHolderRefresh<T extends { id: string; date: number }, P extends {
  rows: T[]; sourceDate: number | null; partial?: boolean; fallback?: boolean;
  delivery?: string; warning?: string;
}>(previous: P | undefined, incoming: P): P {
  if (!previous?.sourceDate || !incoming.sourceDate) {
    if (!previous?.sourceDate || incoming.sourceDate) return incoming;
    return { ...previous, partial: true, delivery: "cache",
      warning: "بروزرسانی جدید تاریخ معتبر ارائه نکرد؛ داده تاریخ‌دار قبلی حفظ شد." };
  }
  if (previous.sourceDate > incoming.sourceDate) {
    return { ...previous, partial: true, delivery: "cache",
      warning: "بروزرسانی جدید فقط داده قدیمی‌تر ارائه کرد؛ اطلاعات معتبر جلسه قبلی حفظ شد." };
  }
  if (previous.sourceDate !== incoming.sourceDate || !incoming.partial || previous.fallback) return incoming;
  // A same-session partial retry can only add verified records. It cannot
  // prove that missing records were removed from the source.
  const rows = new Map(previous.rows.filter(row => row.date === incoming.sourceDate).map(row => [row.id, row]));
  for (const row of incoming.rows) if (row.date === incoming.sourceDate) rows.set(row.id, row);
  if (rows.size <= incoming.rows.length) return incoming;
  return { ...incoming, rows: [...rows.values()], partial: true,
    warning: [incoming.warning, "چند ردیف معتبر از دریافت قبلی همین جلسه حفظ شده‌اند."].filter(Boolean).join(" ") };
}
