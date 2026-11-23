import { normalizeSymbol, type MajorIndividualHoldingIncrease } from "./market";

export type InstrumentInfo = {
  lVal18AFC?: string; zTitad?: number | string | null; flowTitle?: string; sector?: { cSecVal?: string };
  insCode?: string | number;
  // Adapter provenance, never inferred from quote date, retrieval time or dEven.
  requestedInsCode?: string; metadataSource?: string; metadataFetchedAt?: string;
  totalSharesEffectiveDate?: number; totalSharesUnit?: string;
};
export type OwnershipReason = "current_invalid" | "total_unavailable" | "total_invalid" | "unsafe_precision" | "unit_mismatch" | "instrument_mismatch" | "date_mismatch" | "exceeds_total" | "date_unverified" | "historical_unverified" | "reported_invalid";
export type OwnershipValidation = {
  status: "valid" | "unverified" | "invalid" | "unavailable";
  reason: OwnershipReason | null;
  currentShares: number | string | null;
  totalShares: number | string | null;
  holderDate: number | null;
  totalSharesEffectiveDate: number | null;
  instrumentId: string | null;
  metadataInstrumentId: string | null;
  metadataSource: string | null;
  metadataFetchedAt: string | null;
  unit: string;
  reportedPercent?: number | string | null;
};
export type HolderIncreaseRow = MajorIndividualHoldingIncrease & { symbol: string; market: "بورس" | "فرابورس" | "بازار پایه" | "نامشخص"; ownershipPct: number | null; ownership?: OwnershipValidation };

// Counts are whole shares. Reject unsafe/non-decimal inputs rather than guessing
// units or tolerating a shareholder owning more shares than the company issued.
const shareNumber = (value: unknown) => typeof value === "number" ? value
  : typeof value === "string" && /^\d+(?:\.0+)?$/.test(value.trim()) ? Number(value) : NaN;
const diagnostic = (value: unknown): number | string | null => value === undefined || value === null ? null
  : typeof value === "number" && Number.isFinite(value) ? value : String(value);

export function validateOwnership(candidate: Pick<MajorIndividualHoldingIncrease, "currentShares" | "insCode" | "date">, info?: InstrumentInfo | null) {
  const current = shareNumber(candidate.currentShares), total = shareNumber(info?.zTitad);
  const ownership: OwnershipValidation = {
    status: "unverified", reason: "date_unverified",
    currentShares: diagnostic(candidate.currentShares), totalShares: diagnostic(info?.zTitad),
    holderDate: candidate.date ?? null, totalSharesEffectiveDate: info?.totalSharesEffectiveDate ?? null,
    instrumentId: candidate.insCode ?? null, metadataInstrumentId: String(info?.insCode ?? info?.requestedInsCode ?? "") || null,
    metadataSource: info?.metadataSource ?? null, metadataFetchedAt: info?.metadataFetchedAt ?? null,
    unit: info?.totalSharesUnit ?? "shares",
  };
  const reject = (reason: OwnershipReason, status: OwnershipValidation["status"] = "invalid") => ({ ownershipPct: null, ownership: { ...ownership, status, reason } });
  if (!Number.isFinite(current) || current < 0) return reject("current_invalid");
  if (!Number.isSafeInteger(current)) return reject("unsafe_precision");
  if (info?.zTitad === null || info?.zTitad === undefined || info?.zTitad === "" || total === 0) return reject("total_unavailable", "unavailable");
  if (!Number.isFinite(total) || total < 0) return reject("total_invalid");
  if (!Number.isSafeInteger(total)) return reject("unsafe_precision");
  if (ownership.unit !== "shares") return reject("unit_mismatch");
  if (ownership.metadataInstrumentId && ownership.instrumentId && ownership.metadataInstrumentId !== ownership.instrumentId) return reject("instrument_mismatch");
  if (ownership.totalSharesEffectiveDate !== null) {
    const raw = String(ownership.totalSharesEffectiveDate);
    const date = new Date(Date.UTC(+raw.slice(0, 4), +raw.slice(4, 6) - 1, +raw.slice(6, 8)));
    if (!/^\d{8}$/.test(raw) || Number(raw) < 19000101 || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10).replaceAll("-", "") !== raw || ownership.totalSharesEffectiveDate !== ownership.holderDate) return reject("date_mismatch");
  }
  if (current > total) return reject("exceeds_total");
  const ownershipPct = Math.round(current / total * 100_000) / 1_000;
  if (!Number.isFinite(ownershipPct) || ownershipPct < 0 || ownershipPct > 100) return reject("reported_invalid");
  if (ownership.totalSharesEffectiveDate !== null && ownership.metadataInstrumentId && ownership.metadataSource) {
    ownership.status = "valid"; ownership.reason = null;
  }
  return { ownershipPct, ownership };
}

/** Guard legacy/snapshot/API percentages without rewriting historical evidence. */
export function ownershipPresentation(row: { ownershipPct: number | null; ownership?: OwnershipValidation }) {
  const invalid = row.ownership?.status === "invalid" || (row.ownershipPct !== null && (!Number.isFinite(row.ownershipPct) || row.ownershipPct < 0 || row.ownershipPct > 100));
  if (invalid) return { value: null, label: "نامعتبر", explanation: "اطلاعات سهامدار و کل سهام شرکت سازگار نیست؛ درصد مالکیت قابل تأیید نیست." };
  if (row.ownershipPct === null || row.ownership?.status === "unavailable") return { value: null, label: "—", explanation: "اطلاعات معتبر کل سهام شرکت در دسترس نیست." };
  return { value: row.ownershipPct, label: null, explanation: row.ownership?.status === "valid" ? "نسبت محاسبه‌شده با اطلاعات هم‌تاریخ منبع" : "تطبیق مستقل تاریخ تعداد کل سهام شرکت تأیید نشده است." };
}

export function historicalOwnership(row: HolderIncreaseRow): HolderIncreaseRow {
  const presentation = ownershipPresentation(row);
  return { ...row, ownershipPct: presentation.value, ownership: {
    status: presentation.label === "نامعتبر" ? "invalid" : row.ownershipPct === null ? "unavailable" : "unverified",
    reason: presentation.label === "نامعتبر" ? "reported_invalid" : "historical_unverified",
    currentShares: diagnostic(row.currentShares), totalShares: null, holderDate: row.date, totalSharesEffectiveDate: null,
    instrumentId: row.insCode, metadataInstrumentId: null, metadataSource: "bundled-snapshot", metadataFetchedAt: null, unit: "shares", reportedPercent: diagnostic(row.ownershipPct),
  } };
}

export function bindInstrumentInfo(info: InstrumentInfo, requestedInsCode: string): InstrumentInfo {
  if (info.insCode !== undefined && String(info.insCode) !== requestedInsCode) throw new Error("شناسه اطلاعات تکمیلی با نماد درخواستی یکسان نیست.");
  return { ...info, requestedInsCode, metadataSource: "TSETMC Instrument/GetInstrumentInfo", metadataFetchedAt: new Date().toISOString(), totalSharesUnit: info.totalSharesUnit ?? "shares" };
}

export function enrichHolding(candidate: MajorIndividualHoldingIncrease, info?: InstrumentInfo | null): HolderIncreaseRow | null {
  if (!info?.lVal18AFC) return null;
  const symbol = normalizeSymbol(info.lVal18AFC);
  const title = normalizeSymbol(String(info.flowTitle ?? ""));
  const market = title.includes("پایه") ? "بازار پایه" : title.includes("فرابورس") ? "فرابورس" : title.includes("بورس") ? "بورس" : null;
  if (!market || symbol.endsWith("ح") || /\d+$/.test(symbol) || String(info.sector?.cSecVal).trim() === "68") return null;
  return { ...candidate, symbol, market, ...validateOwnership(candidate, info) };
}

/** Preserve a confirmed official shareholder change when the instrument's
 * identity was resolved by an independent symbol→insCode lookup, but its
 * TSETMC metadata is unavailable. Market and ownership stay unverified. */
export function unresolvedHolding(candidate: MajorIndividualHoldingIncrease, mappedSymbol: string, info?: InstrumentInfo | null): HolderIncreaseRow | null {
  const symbol = normalizeSymbol(mappedSymbol);
  if (!symbol || symbol.endsWith("ح") || /\d+$/.test(symbol)) return null;
  if (info) {
    // Keep existing exclusion rules for rights, funds, and mismatched symbols.
    if (String(info.sector?.cSecVal).trim() === "68" ||
      (info.lVal18AFC && normalizeSymbol(info.lVal18AFC) !== symbol)) return null;
    const marketLabel = normalizeSymbol(info.flowTitle ?? "");
    // A definitive allowed-market result is handled by enrichHolding; do not
    // override an intentional exclusion with an unverified fallback.
    if (marketLabel.includes("پایه") || marketLabel.includes("فرابورس") || marketLabel.includes("بورس")) return null;
  }
  return {
    ...candidate, symbol, market: "نامشخص",
    ...validateOwnership(candidate),
  };
}
