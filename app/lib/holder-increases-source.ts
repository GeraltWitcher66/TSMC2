import { compactTehranDate } from "./market";
import { holderSessionCoverage, selectHolderSession } from "./market-session";
import { bindInstrumentInfo, type InstrumentInfo } from "./holder-records";
import { upstreamJson, diagnosticOf, type UpstreamDiagnostic } from "./upstream";

const HOSTS = ["cdn.tsetmc.com", "tsetmc.com"] as const;
const SHAREHOLDER_PATH = "Shareholder/GetShareHolderChanges/false";
const HEADERS = { Accept: "application/json", "User-Agent": "Mozilla/5.0", Referer: "https://tsetmc.com/", "Cache-Control": "no-cache" };

/** A dated official snapshot requires a valid current and previous source slot.
 * An unfilled future fifth slot is acceptable, but never evidence of a zero. */
export function validateHolderChangesPayload(payload: unknown, now = new Date()) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const value = payload as { dates?: unknown[]; shareHoldersChanges?: unknown[] };
  if (!Array.isArray(value.dates) || !Array.isArray(value.shareHoldersChanges) || !value.shareHoldersChanges.length) return false;
  if (value.shareHoldersChanges.some((holder) => !holder || typeof holder !== "object" || Array.isArray(holder) ||
    (holder as { insList?: unknown }).insList !== undefined && !Array.isArray((holder as { insList?: unknown }).insList))) return false;
  const selection = selectHolderSession(value.dates, now);
  if (selection.index < 1 || selection.previousIndex < 0 || selection.sourceDate === null) return false;
  // A dated but structurally empty HTTP 200 is not proof of zero holder changes.
  // Demand at least one actual instrument observation in the selected slot.
  const dayKeys = ["firstDay", "secondDay", "thirdDay", "fourthDay", "fifthDay"];
  // Partial snapshots are still useful evidence, but cannot establish zeros;
  // an apparently complete snapshot must include its selected session.
  const observedKeys = selection.completeForSelectedSession
    ? [dayKeys[selection.index]] : dayKeys.slice(0, selection.index + 1);
  return value.shareHoldersChanges.some((rawHolder) => {
    const instruments = (rawHolder as { insList?: unknown }).insList;
    return Array.isArray(instruments) && instruments.some((rawInstrument) => {
      if (!rawInstrument || typeof rawInstrument !== "object" || Array.isArray(rawInstrument)) return false;
      const instrument = rawInstrument as Record<string, unknown>;
      return /^[A-Za-z0-9]+$/.test(String(instrument.insCode ?? "").trim()) &&
        observedKeys.some((dayKey) => {
          const shares = instrument[dayKey];
          return shares !== null && shares !== undefined && shares !== "" &&
            Number.isSafeInteger(Number(shares)) && Number(shares) >= 0;
        });
    });
  });
}

const utcDate = (date: number) => Date.UTC(Math.floor(date / 10000), Math.floor(date / 100) % 100 - 1, date % 100);
export function holderSourceAgeDays(sourceDate: number, now = new Date()) {
  return Math.max(0, Math.round((utcDate(compactTehranDate(now)) - utcDate(sourceDate)) / 86_400_000));
}

export type OfficialHolderSource = { payload: unknown; sourceDate: number; sourceHost: string; fetchedAt: string; sourceAgeDays: number };

/** Bounded, schema-checked official mirrors. Malformed HTTP 200 cannot block
 * a valid response from the second host or be treated as live changes. */
export async function fetchOfficialHolderChanges(
  options: { request?: typeof fetch; observe?: (event: UpstreamDiagnostic) => void } = {},
): Promise<OfficialHolderSource> {
  let firstFailure: unknown;
  let selected: OfficialHolderSource | null = null;
  for (const host of HOSTS) {
    try {
      const payload = await upstreamJson(`https://${host}/api/${SHAREHOLDER_PATH}`, {
        timeoutMs: host === HOSTS[0] ? 5_000 : 6_000,
        headers: HEADERS,
        request: options.request,
        observe: options.observe,
        validate: validateHolderChangesPayload,
      });
      const sourceDate = holderSessionCoverage(payload).sourceDate!;
      const candidate = { payload, sourceDate, sourceHost: host, fetchedAt: new Date().toISOString(), sourceAgeDays: holderSourceAgeDays(sourceDate) };
      if (!selected || candidate.sourceDate > selected.sourceDate) selected = candidate;
      // Normally one successful host suffices. If it is over a week old,
      // check the second official host before trusting that historical session.
      if (candidate.sourceAgeDays <= 7) return selected;
    } catch (error) {
      firstFailure ??= error;
    }
  }
  if (selected) return selected;
  throw firstFailure ?? new Error("اطلاعات رسمی تغییرات سهامداران در دسترس نیست.");
}

/** An instrument result must resolve to a real symbol and the requested ID.
 * A malformed primary response is not a successful metadata lookup. */
export async function fetchOfficialHolderInstrumentInfo(
  insCode: string,
  request: typeof fetch = fetch,
): Promise<InstrumentInfo> {
  let lastError: unknown;
  for (const host of HOSTS) {
    try {
      const payload = await upstreamJson<{ instrumentInfo?: InstrumentInfo }>(
        `https://${host}/api/Instrument/GetInstrumentInfo/${encodeURIComponent(insCode)}`,
        { timeoutMs: 2_500, headers: HEADERS, request,
          validate: (value) => Boolean(value && typeof value === "object" &&
            (value as { instrumentInfo?: { lVal18AFC?: unknown } }).instrumentInfo &&
            typeof (value as { instrumentInfo: { lVal18AFC?: unknown } }).instrumentInfo.lVal18AFC === "string" &&
            (value as { instrumentInfo: { lVal18AFC: string } }).instrumentInfo.lVal18AFC.trim()),
        },
      );
      return bindInstrumentInfo(payload.instrumentInfo!, insCode);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("مشخصات رسمی نماد در دسترس نیست.");
}

export function officialHolderDiagnostic(error: unknown) {
  return diagnosticOf(error) ?? null;
}
