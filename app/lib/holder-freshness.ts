export type HolderDelivery = "source" | "cache" | "bundled";
export type HolderFreshness = { sourceDate?: number | null; fallback?: boolean; partial?: boolean; delivery?: HolderDelivery };

export function holderFreshnessText(data?: HolderFreshness | null, expectedSession?: number | null) {
  if (!data?.sourceDate) return "تاریخ داده سهامداران در دسترس نیست؛ تازگی اطلاعات تأیید نشده است.";
  const raw = String(data.sourceDate);
  const date = new Date(Date.UTC(+raw.slice(0, 4), +raw.slice(4, 6) - 1, +raw.slice(6, 8)));
  if (!/^\d{8}$/.test(raw) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replaceAll("-", "") !== raw) return "تاریخ داده سهامداران نامعتبر است؛ تازگی اطلاعات تأیید نشده است.";
  const formatted = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  const origin = data.fallback || data.delivery === "bundled" ? "نسخه پشتیبان تاریخی" : data.delivery === "cache" ? "داده ذخیره‌شده قبلی" : "داده دریافت‌شده از منبع";
  const stale = Boolean(expectedSession && data.sourceDate < expectedSession);
  return `${origin}؛ تاریخ داده سهامداران: ${formatted}.${stale ? " این داده مربوط به جلسه مورد انتظار امروز نیست." : ""}${data.fallback || data.delivery === "bundled" ? " اتصال زنده با این پاسخ تأیید نمی‌شود." : ""}${data.partial ? " دریافت ناقص است؛ نبود ردیف، نبود خرید را ثابت نمی‌کند." : ""}`;
}
