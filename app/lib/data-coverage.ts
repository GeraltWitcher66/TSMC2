import type { MarketHighlight } from "./market";
import { sourceSession } from "./market-session";

export function highlightCoverage(rows: MarketHighlight[], requested: number) {
  const dated = rows.filter(r => sourceSession(r.sessionDate));
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  return { requested, received: rows.length, datedPrices: dated.filter(r => r.priceLast > 0 && r.priceClose > 0).length,
    volume: dated.filter(r => r.volumeAvailable !== false && finite(r.volume) && (r.volume > 0 || r.volumeAvailable === true)).length,
    value: dated.filter(r => r.valueAvailable !== false && finite(r.value) && (r.value > 0 || r.valueAvailable === true)).length,
    clientType: dated.filter(r => r.clientTypeAvailable && r.clientTypeDate === r.sessionDate).length,
    realValues: dated.filter(r => r.clientTypeDate === r.sessionDate && finite(r.realBuyValue) && finite(r.realSellValue)).length,
    floor: dated.filter(r => r.floorVerified).length,
    sameSession: dated.filter(r => r.floorVerified && r.clientTypeAvailable && r.clientTypeDate === r.sessionDate).length,
    cached: rows.filter(r => r.delivery === "cache").length,
    unreceived: Math.max(0, requested - rows.length), unverifiedDate: rows.length - dated.length };
}

export function emptyDataMessage(kind: "money" | "floor", verified: number, requested: number) {
  if (!requested) return "فهرست انتخاب‌شده خالی است.";
  if (!verified) return kind === "money" ? "دادهٔ معتبر ورود پول حقیقی دریافت نشد؛ نتیجه قابل تعیین نیست." : "کف مجاز هم‌جلسه تأیید نشد؛ نتیجهٔ این الگو قابل تعیین نیست.";
  if (verified < requested) return "در بخش بررسی‌شده موردی پیدا نشد؛ پوشش فهرست ناقص است.";
  return kind === "money" ? "ورود پول حقیقی مثبت در این فهرست دیده نشد." : "در آخرین جلسه نمادی با هر سه شرط دقیق پیدا نشد.";
}
