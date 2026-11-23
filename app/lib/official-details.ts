import { applyClientTypeToHighlight, type MarketHighlight } from "./market";
import { datedClientType, sourceSession } from "./market-session";
import { upstreamJson, type UpstreamDiagnostic } from "./upstream";
import { mapWithConcurrency, RequestCoalescer } from "./data-reliability";
import { withDeadline } from "./request-lifecycle";
import { validateHolderChangesPayload } from "./holder-increases-source";

export const HIGHLIGHT_BATCH_SIZE = 10; // Quotes + ClientType + floors stay below 50 Worker subrequests.
const cache = new RequestCoalescer<Record<string, unknown>>(30_000, 500);
const BASE = "https://cdn.tsetmc.com/api";
const safeNumber = (value: unknown) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;

/** The history response has recDate and *_I_Count; the all-market feed does not have a date. */
export function parseDatedClientType(payload: unknown, code: string, date: number) {
  const item = (payload as { clientType?: Record<string, unknown> } | null)?.clientType;
  if (!item || String(item.insCode) !== code || sourceSession(item.recDate) !== date) return null;
  const mapped = { ...item, dEven: Number(item.recDate), buy_CountI: item.buy_I_Count, sell_CountI: item.sell_I_Count,
    buy_CountN: item.buy_N_Count, sell_CountN: item.sell_N_Count };
  return datedClientType(mapped, date) ? mapped : null;
}

/** TSETMC returns insCode=0 for this path; bind that sentinel to the requested URL, reject conflicting explicit IDs. */
export function parseOfficialFloor(payload: unknown, date: number, code?: string): number | null {
  if (!sourceSession(date)) return null;
  const rows = (payload as { staticThreshold?: Record<string, unknown>[] } | null)?.staticThreshold;
  if (!Array.isArray(rows)) return null;
  const exact = rows.filter((r) => r && Number(r.dEven) === date && safeNumber(r.psGelStaMin) !== null && Number(r.psGelStaMin) > 0
    && (!code || r.insCode == null || String(r.insCode) === "0" || String(r.insCode) === code))
    .sort((a, b) => Number(b.hEven ?? 0) - Number(a.hEven ?? 0))[0];
  return exact ? Number(exact.psGelStaMin) : null;
}

/** Accept an official dated record only for the requested instrument and session.
 * Other read-only TSETMC endpoints retain their existing response handling. */
export function validOfficialDatedPayload(path: string, payload: unknown) {
  if (/^Share[Hh]older\/GetShareHolderChanges(?:\/false)?$/.test(path)) return validateHolderChangesPayload(payload);
  const client = /^ClientType\/GetClientTypeHistory\/([^/]+)\/(\d{8})$/.exec(path);
  if (client) return parseDatedClientType(payload, client[1], Number(client[2])) !== null;
  const floor = /^MarketData\/GetStaticThreshold\/([^/]+)\/(\d{8})$/.exec(path);
  if (floor) return parseOfficialFloor(payload, Number(floor[2]), floor[1]) !== null;
  return true;
}

export function enrichDatedClientType(row: MarketHighlight, typed: Record<string, unknown>) {
  const enriched = applyClientTypeToHighlight(row, typed);
  const realBuyValue = safeNumber(typed.buy_I_Value), realSellValue = safeNumber(typed.sell_I_Value);
  return { ...enriched, realBuyValue, realSellValue, clientTypeDate: row.sessionDate,
    netRealValue: realBuyValue !== null && realSellValue !== null ? realBuyValue - realSellValue : row.netRealValue };
}

export async function officialDetails(rows: MarketHighlight[], observe?: (event: UpstreamDiagnostic) => void, parent?: AbortSignal) {
  const output = [...rows];
  try {
    await withDeadline(async (signal) => {
      await mapWithConcurrency(rows, 2, async (row, index) => {
        if (signal.aborted || !row.insCode || !row.sessionDate) return;
        const date = row.sessionDate, code = row.insCode;
        const read = async (kind: "client" | "floor") => {
          const key = `${kind}:${code}:${date}`;
          return cache.run(key, async () => {
            const path = kind === "client" ? `ClientType/GetClientTypeHistory/${code}/${date}` : `MarketData/GetStaticThreshold/${code}/${date}`;
            const payload = await upstreamJson(`${BASE}/${path}`, { timeoutMs: 4_000, signal, observe });
            const value = kind === "client" ? parseDatedClientType(payload, code, date) : parseOfficialFloor(payload, date, code);
            if (value === null) throw new Error("اطلاعات رسمی هم‌جلسه معتبر نیست.");
            return { value, fetchedAt: new Date().toISOString() };
          });
        };
        const [client, floor] = await Promise.allSettled([read("client"), read("floor")]);
        if (signal.aborted) return;
        let next = row;
        if (client.status === "fulfilled") next = { ...enrichDatedClientType(next, client.value.value as Record<string, unknown>), clientTypeFetchedAt: String(client.value.fetchedAt) };
        if (floor.status === "fulfilled") {
          const allowedMin = Number(floor.value.value);
          next = { ...next, allowedMin, floorVerified: true, floorDate: date, floorFetchedAt: String(floor.value.fetchedAt), touchedSellQueue: row.priceMin > 0 && Math.abs(row.priceMin - allowedMin) < 0.5 };
        }
        output[index] = next;
      });
    }, 10_000, parent);
  } catch { /* Completed, independently valid results survive expiry. */ }
  return output;
}
