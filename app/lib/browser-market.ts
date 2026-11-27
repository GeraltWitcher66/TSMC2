import { fetchWithTimeout } from "./request-lifecycle";
import { relayUrl } from "./data-client";
import { extractMajorHolderChanges, extractMajorIndividualHoldingChanges, extractMajorIndividualHoldingIncreases, normalizeSymbol, summarizeMajorIndividualHoldingChanges, toApiSymbol } from "./market";
import { mapWithConcurrency, RequestCoalescer } from "./data-reliability";
import { bindInstrumentInfo, enrichHolding, unresolvedHolding, type HolderIncreaseRow, type InstrumentInfo } from "./holder-records";
import { holderSessionCoverage } from "./market-session";
import { holderSourceAgeDays, validateHolderChangesPayload } from "./holder-increases-source";

const BASE = "https://cdn.tsetmc.com/api";
type Ref = { symbol: string; insCode: string };

// A browser can reach TSETMC from networks where the Worker's egress is blocked.
// The direct path uses the same parsers and ownership rules as the server.
export function createBrowserMarketClient(request: typeof fetch = fetch) {
  const changesCache = new RequestCoalescer<{ payload: unknown; date: number; fetchedAt: string }>(60_000, 1);
  const infoCache = new RequestCoalescer<InstrumentInfo>(120_000, 600);
  async function json(url: string, signal?: AbortSignal, validate: (value: unknown) => boolean = () => true) {
    const relayPath = url.startsWith(`${BASE}/`) ? url.slice(BASE.length + 1) : null;
    try {
      const response = await fetchWithTimeout(url, { cache: "no-store", signal }, 12_000, request);
      if (response.ok) {
        const payload = await response.json();
        if (validate(payload)) return payload;
      }
    } catch { /* fall through to the relay for TSETMC URLs */ }
    if (!relayPath) throw new Error("منبع رسمی از مرورگر نیز پاسخ معتبر نداد.");
    const relayed = await fetchWithTimeout(relayUrl(relayPath), { cache: "no-store", signal }, 15_000, request);
    if (!relayed.ok) throw new Error("منبع رسمی از مرورگر نیز پاسخ معتبر نداد.");
    const payload = await relayed.json();
    if (!validate(payload)) throw new Error("تاریخ یا ساختار پاسخ بازیابی‌شده منبع رسمی معتبر نیست.");
    return payload;
  }
  async function changes() {
    let fetched = false;
    const cached = await changesCache.run("changes", async () => {
      fetched = true;
      const payload = await json(`${BASE}/Shareholder/GetShareHolderChanges/false`, undefined, validateHolderChangesPayload);
      const date = holderSessionCoverage(payload).sourceDate;
      const dates = Array.isArray(payload?.dates) ? payload.dates.slice(0, 5).map(Number) : [];
      if (!date || dates.indexOf(date) < 1 || !Array.isArray(payload?.shareHoldersChanges)) throw new Error("تاریخ یا ساختار تغییرات رسمی معتبر نیست.");
      return { payload, date, fetchedAt: new Date().toISOString() };
    });
    return { ...cached, delivery: fetched ? "source" as const : "cache" as const };
  }
  async function summaries(refs: Ref[]) {
    const { payload, date, fetchedAt, delivery } = await changes();
    const byCode = summarizeMajorIndividualHoldingChanges(extractMajorIndividualHoldingChanges(payload));
    const complete = holderSessionCoverage(payload).completeForSelectedSession;
    const historical = holderSourceAgeDays(date) > 7;
    return { summaries: Object.fromEntries(refs.flatMap(({ symbol, insCode }) => byCode[insCode] ? [[symbol, byCode[insCode]]] : complete && !historical ? [[symbol, { buyCount: 0, sellCount: 0, buyShares: 0, sellShares: 0 }]] : [])), sourceDate: date, fetchedAt, delivery, fallback: false, partial: !complete || historical };
  }
  async function holders(symbols?: string[], isCurrent: () => boolean = () => true, signal?: AbortSignal) {
    const check = () => { if (signal?.aborted || !isCurrent()) throw new Error("محدوده اسکن تغییر کرد."); };
    check();
    const { payload, date, fetchedAt, delivery } = await changes();
    let candidates = extractMajorIndividualHoldingIncreases(payload);
    const requested = symbols ? new Set(symbols.map(normalizeSymbol)) : null;
    let missingCount = 0;
    let lookupFailures = 0;
    const symbolsByCode = new Map<string, string>();
    if (requested) {
      const refs: Ref[] = [];
      const list = [...requested];
      for (let index = 0; index < list.length; index += 20) {
        check();
        const part = list.slice(index, index + 20);
        try {
          const instruments = await json(`https://zarvanfund.ir/api/instruments?syms=${encodeURIComponent(part.map(toApiSymbol).join(","))}`, signal);
          if (!instruments || typeof instruments !== "object" || Array.isArray(instruments)) throw new Error("مشخصات فهرست معتبر نیست.");
          const allowed = new Set(part);
          for (const [key, raw] of Object.entries(instruments)) {
            const symbol = normalizeSymbol(key);
            const insCode = String((raw as Record<string, unknown> | null)?.InsCode ?? "").trim();
            if (allowed.has(symbol) && /^[A-Za-z0-9]+$/.test(insCode)) refs.push({ symbol, insCode });
          }
        } catch { lookupFailures++; }
      }
      missingCount = requested.size - new Set(refs.map((item) => item.symbol)).size;
      for (const ref of refs) {
        if (symbolsByCode.has(ref.insCode) && symbolsByCode.get(ref.insCode) !== ref.symbol) symbolsByCode.set(ref.insCode, "");
        else if (!symbolsByCode.has(ref.insCode)) symbolsByCode.set(ref.insCode, ref.symbol);
      }
      const codes = new Set(refs.map((item) => item.insCode));
      candidates = candidates.filter((row) => codes.has(row.insCode));
    }
    const codes = [...new Set(candidates.map((row) => row.insCode))];
    let consecutiveFailures = 0;
    const infos = await mapWithConcurrency(codes, 4, async (code) => {
      check();
      if (consecutiveFailures >= 4) return [code, null] as const;
      try {
        const info = await infoCache.run(code, async () => {
          const data = await json(`${BASE}/Instrument/GetInstrumentInfo/${encodeURIComponent(code)}`, undefined, (payload) => {
            const info = (payload as { instrumentInfo?: InstrumentInfo } | null)?.instrumentInfo;
            return Boolean(info && typeof info.lVal18AFC === "string" && info.lVal18AFC.trim() &&
              (info.insCode === undefined || String(info.insCode) === code));
          });
          if (!data?.instrumentInfo?.lVal18AFC) throw new Error("مشخصات نماد موجود نیست.");
          return bindInstrumentInfo(data.instrumentInfo as InstrumentInfo, code);
        });
        consecutiveFailures = 0;
        return [code, info] as const;
      } catch { consecutiveFailures++; return [code, null] as const; }
    });
    check();
    const failedInfo = infos.filter(([, info]) => !info).length;
    if (!requested && codes.length && failedInfo === codes.length) throw new Error("مشخصات سهامداران دریافت نشد؛ شناسه نمادها قابل تأیید نیست.");
    const byCode = new Map(infos);
    let recoveredRows = 0;
    let unresolvedRows = 0;
    // Card 3 needs legal major shareholders by name; it reuses this payload
    // and the code→symbol map instead of a new request.
    const majorHolders = extractMajorHolderChanges(payload).flatMap((change) => {
      const symbol = symbolsByCode.get(change.insCode);
      if (!symbol || (requested && !requested.has(symbol)) || symbol.endsWith("ح") || /\d+$/.test(symbol)) return [];
      return [{ ...change, symbol }];
    });
    const rows: HolderIncreaseRow[] = candidates.flatMap((candidate) => {
      const info = byCode.get(candidate.insCode);
      let row = info ? enrichHolding(candidate, info) : null;
      if (!row && symbolsByCode.get(candidate.insCode)) {
        row = unresolvedHolding(candidate, symbolsByCode.get(candidate.insCode)!, info);
        if (row) recoveredRows++;
      }
      if (!row && !info) unresolvedRows++;
      return row && (!requested || requested.has(row.symbol)) ? [row] : [];
    });
    return { rows: rows.sort((a, b) => b.changeShares - a.changeShares), majorHolders, sourceDate: date, fetchedAt, delivery, partial: missingCount > 0 || lookupFailures > 0 || failedInfo > 0 || recoveredRows > 0 || unresolvedRows > 0 || !holderSessionCoverage(payload).completeForSelectedSession || holderSourceAgeDays(date) > 7, sourceCompleteness: holderSessionCoverage(payload).completeForSelectedSession ? "selected-session" : "earlier-session-subset", fallback: false };
  }
  return { holders, summaries };
}

export const browserMarket = createBrowserMarketClient();
