import {
  extractMajorIndividualHoldingChanges, extractMajorIndividualHoldingIncreases,
  normalizeSymbol, summarizeMajorIndividualHoldingChanges, toApiSymbol,
  type MajorIndividualHoldingSummary,
} from "../../lib/market";
import { mapWithConcurrency, RequestCoalescer } from "../../lib/data-reliability";
import { loadVerifiedHolderSnapshot } from "../../data/holder-snapshot";
import { enrichHolding, historicalOwnership, unresolvedHolding, type InstrumentInfo, type HolderIncreaseRow } from "../../lib/holder-records";
import { fetchOfficialHolderChanges, fetchOfficialHolderInstrumentInfo, officialHolderDiagnostic, type OfficialHolderSource } from "../../lib/holder-increases-source";
import { upstreamJson, diagnosticOf, type UpstreamDiagnostic } from "../../lib/upstream";
import { holderSessionCoverage, lastClosedEquitySession } from "../../lib/market-session";

const HEADERS = { Accept: "application/json", "User-Agent": "Mozilla/5.0", Referer: "https://tsetmc.com/", "Cache-Control": "no-cache" };
const NO_STORE = { "Cache-Control": "no-store, no-cache, must-revalidate", Pragma: "no-cache", Expires: "0" };
const PAGE_SIZE = 20;
const SYMBOL_LOOKUP_SIZE = 20;
const validSymbol = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= 64 && Boolean(normalizeSymbol(value)) && !/^\d+$/.test(normalizeSymbol(value));
const validCode = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9]{1,32}$/.test(value.trim());
const validCursor = (value: unknown) => (typeof value === "number" || typeof value === "string") && String(value).trim() !== "" && Number.isSafeInteger(Number(value)) && Number(value) >= 0;
const validSourceDate = (value: unknown) => {
  if (value === undefined || value === null || value === "") return true;
  if (!/^[0-9]{8}$/.test(String(value))) return false;
  const s = String(value), date = new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6)));
  return Number(s) >= 19000101 && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replaceAll("-", "") === s;
};
const changesCache = new RequestCoalescer<OfficialHolderSource>(60_000, 1);
const infoCache = new RequestCoalescer<InstrumentInfo>(2 * 60_000, 600);
type InstrumentRef = { symbol: string; insCode: string };
type ScopeResolution = { refs: InstrumentRef[]; lookupFailures: number };
// Subsequent 20-code pages of one 100-symbol scope must reuse the same
// bounded code mapping. Keep it short-lived so a new scan can recover gaps.
const scopeCache = new RequestCoalescer<ScopeResolution>(30_000, 16);

async function fetchJson(url: string, timeoutMs: number): Promise<unknown> {
  return upstreamJson(url, { headers: HEADERS, timeoutMs });
}

async function changesPayload() {
  let fetched = false;
  const cached = await changesCache.run("changes", async () => {
    fetched = true;
    return fetchOfficialHolderChanges();
  });
  return { ...cached, delivery: fetched ? "source" as const : "cache" as const };
}

async function instrumentInfo(insCode: string) {
  return infoCache.run(insCode, async () => fetchOfficialHolderInstrumentInfo(insCode));
}

async function resolveSymbols(symbols: string[]) {
  return scopeCache.run(symbols.join(","), () => resolveSymbolsUncached(symbols));
}

async function resolveSymbolsUncached(symbols: string[]): Promise<ScopeResolution> {
  const requested = new Set(symbols);
  const pages = Array.from({ length: Math.ceil(symbols.length / SYMBOL_LOOKUP_SIZE) }, (_, i) => symbols.slice(i * SYMBOL_LOOKUP_SIZE, (i + 1) * SYMBOL_LOOKUP_SIZE));
  const resolved = await mapWithConcurrency(pages, 3, async (batch) => {
    try {
      const payload = await fetchJson(`https://zarvanfund.ir/api/instruments?syms=${encodeURIComponent(batch.map(toApiSymbol).join(","))}`, 12_000);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("پاسخ مشخصات فهرست معتبر نیست");
      const result: InstrumentRef[] = [];
      const allowed = new Set(batch);
      for (const [key, raw] of Object.entries(payload)) {
        const symbol = normalizeSymbol(key);
        if (!allowed.has(symbol) || !raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const insCode = String((raw as Record<string, unknown>).InsCode ?? "").trim();
        if (/^[A-Za-z0-9]+$/.test(insCode) && requested.has(symbol)) result.push({ symbol, insCode });
      }
      return { result, failed: false };
    } catch { return { result: [] as InstrumentRef[], failed: true }; }
  });
  const result = [...new Map(resolved.flatMap((page) => page.result).map((ref) => [ref.symbol, ref])).values()];
  return { refs: result, lookupFailures: resolved.filter((page) => page.failed).length };
}

async function fallbackRows(
  symbols?: string[], reason = "منبع زنده در دسترس نیست", diagnostic?: UpstreamDiagnostic,
  cursor = 0, expectedDate?: number,
) {
  const snapshot = await loadVerifiedHolderSnapshot<HolderIncreaseRow, MajorIndividualHoldingSummary>();
  if (expectedDate && expectedDate !== snapshot.sourceDate) return Response.json({
    error: "تاریخ نسخه پشتیبان با صفحه قبلی یکسان نیست؛ اسکن را دوباره اجرا کنید.",
  }, { status: 409, headers: NO_STORE });
  const requested = symbols ? new Set(symbols) : null;
  const candidates = snapshot.rows.filter((row) => !requested || requested.has(normalizeSymbol(row.symbol)));
  const page = candidates.slice(cursor, cursor + PAGE_SIZE);
  return Response.json({
    rows: page.map(historicalOwnership),
    sourceDate: snapshot.sourceDate, fetchedAt: snapshot.fetchedAt, servedAt: new Date().toISOString(),
    source: snapshot.source, delivery: "bundled", fallback: true, partial: true, failedInfo: 0,
    sourceCompleteness: "earlier-session-subset",
    nextCursor: cursor + PAGE_SIZE < candidates.length ? cursor + PAGE_SIZE : null,
    warning: `${reason} این اطلاعات متعلق به نسخه تاریخی ${snapshot.sourceDate} هستند و تکمیل جلسه معاملاتی کنونی را تأیید نمی‌کنند.`,
    diagnostics: { outcome: "FALLBACK_BUNDLED", upstream: diagnostic ?? null },
  }, { headers: { ...NO_STORE, "X-Data-Fallback": "verified-tsetmc-snapshot" } });
}

async function rowPage(cursor: number, symbols?: string[], expectedDate?: number, bundledContinuation = false) {
  // The consumer explicitly retains its preceding page's fallback provenance.
  // Without the mode an official page and an archive page can have the same
  // sourceDate and silently mix results across datasets.
  if (bundledContinuation) return fallbackRows(symbols, "در حال ادامه دریافت نسخه پشتیبان تاریخی.", undefined, cursor, expectedDate);
  let sourced: Awaited<ReturnType<typeof changesPayload>>;
  try {
    sourced = await changesPayload();
  } catch (error) {
    // Only failure of the dated official dataset itself can select the bundled
    // historical snapshot. Metadata failure must not backdate valid live data.
    if (cursor > 0) return Response.json({ error: error instanceof Error ? error.message : "اسکن ناقص ماند" }, { status: 502, headers: NO_STORE });
    return fallbackRows(symbols, error instanceof Error ? error.message : undefined, officialHolderDiagnostic(error) ?? undefined, cursor, expectedDate);
  }
  const { payload, fetchedAt, delivery, sourceHost, sourceDate: date, sourceAgeDays } = sourced;
  if (expectedDate && date !== expectedDate) return Response.json({ error: "جلسه منبع هنگام اسکن تغییر کرد؛ اسکن را دوباره اجرا کنید." }, { status: 409, headers: NO_STORE });
  const completeness = holderSessionCoverage(payload).completeForSelectedSession;
  // A source can contain a complete pair of old dates while having no
  // observations for the last expected ordinary-equity session.
  const currentCoverage = completeness && date === lastClosedEquitySession();
  const provenance = { kind: "official" as const, host: sourceHost, sourceDate: date, sourceAgeDays, fetchedAt, servedAt: new Date().toISOString(), currentSessionConfirmed: false };
  const historicalWarning = sourceAgeDays > 7 ? `تاریخ داده رسمی ${date} بیش از هفت روز تقویمی پیش است؛ دریافت از منبع رسمی به معنی تازه‌بودن جلسه نیست.` : "";
  const unconfirmedSessionWarning = date < lastClosedEquitySession() && sourceAgeDays <= 7
    ? `تاریخ داده رسمی ${date} پیش از آخرین جلسه عادی مورد انتظار است؛ پوشش جلسه تازه تأیید نشده است.` : "";
  let missingCount = 0;
  try {
    let candidates = extractMajorIndividualHoldingIncreases(payload);
    const sourcePositiveRecords = candidates.length;
    let lookupFailures = 0;
    const symbolsByCode = new Map<string, string>();
    if (symbols) {
      const lookup = await resolveSymbols(symbols);
      const instruments = lookup.refs;
      lookupFailures = lookup.lookupFailures;
      const codes = new Set(instruments.map((item) => item.insCode));
      missingCount = symbols.length - new Set(instruments.map((item) => item.symbol)).size;
      candidates = candidates.filter((item) => codes.has(item.insCode));
      for (const instrument of instruments) {
        // Do not assign a single code to multiple aliases; its ticker would be ambiguous.
        if (symbolsByCode.has(instrument.insCode) && symbolsByCode.get(instrument.insCode) !== instrument.symbol) symbolsByCode.set(instrument.insCode, "");
        else if (!symbolsByCode.has(instrument.insCode)) symbolsByCode.set(instrument.insCode, instrument.symbol);
      }
    }
    // Page by actual shareholder rows. A single instrument may have dozens of
    // individual buyers, so paging by 20 distinct instrument codes can return
    // arbitrarily many rows in one response.
    const pageCandidates = candidates.slice(cursor, cursor + PAGE_SIZE);
    const pageCodes = [...new Set(pageCandidates.map((item) => item.insCode))];
    const infos = await mapWithConcurrency(pageCodes, 4, async (code) => {
      try { return [code, await instrumentInfo(code)] as const; } catch { return [code, null] as const; }
    });
    const failedInfo = infos.filter(([, info]) => !info).length;
    const byCode = new Map(infos);
    let recoveredRows = 0;
    let unresolvedRows = 0;
    let excludedRows = 0;
    const requested = symbols ? new Set(symbols) : null;
    const rows: HolderIncreaseRow[] = pageCandidates.flatMap((candidate) => {
      const info = byCode.get(candidate.insCode);
      let row = enrichHolding(candidate, info);
      if (!row && symbolsByCode.get(candidate.insCode)) {
        // TSETMC confirms the person's signed share-count change; Zarvan's
        // scoped code lookup independently confirms the symbol. Keep the
        // observation but never invent its market or ownership percentage.
        row = unresolvedHolding(candidate, symbolsByCode.get(candidate.insCode)!, info);
        if (row) recoveredRows++;
      }
      if (!row) { if (!info) unresolvedRows++; else excludedRows++; }
      if (row && (!requested || requested.has(row.symbol))) return [row];
      if (row) unresolvedRows++;
      return [];
    });
    const metadataUnavailable = pageCodes.length > 0 && failedInfo === pageCodes.length;
    return Response.json({ rows, sourceDate: date, fetchedAt, servedAt: provenance.servedAt, delivery, fallback: false, source: "TSETMC Shareholder Changes", provenance,
      partial: failedInfo > 0 || missingCount > 0 || lookupFailures > 0 || recoveredRows > 0 || unresolvedRows > 0 || !currentCoverage || sourceAgeDays > 7, failedInfo, missingCount, lookupFailures,
      sourcePositiveRecords, scopedPositiveRecords: candidates.length, pagePositiveRecords: pageCandidates.length, recoveredRows, unresolvedRows, excludedRows,
      warning: [historicalWarning, unconfirmedSessionWarning, recoveredRows ? `${recoveredRows} رکورد تغییر مثبت با شناسه نماد تأییدشده و بدون مشخصات تکمیلی حفظ شد؛ بازار و درصد مالکیت آن‌ها نامشخص است.` : "", metadataUnavailable ? "مشخصات رسمی ابزارهای این صفحه در دسترس نیست." : "", missingCount ? `${missingCount} نماد از فهرست در نگاشت منبع تکمیلی شناسایی نشد؛ نبود ردیف به معنای نبود خرید نیست.` : "", unresolvedRows ? `${unresolvedRows} رکورد مثبت بدون شناسه قابل‌تأیید نمایش داده نشد.` : ""].filter(Boolean).join(" ") || undefined,
      sourceCompleteness: currentCoverage ? "selected-session" : "earlier-session-subset",
      nextCursor: cursor + PAGE_SIZE < candidates.length ? cursor + PAGE_SIZE : null,
    }, { headers: NO_STORE });
  } catch (error) {
    return Response.json({ rows: [], sourceDate: date, fetchedAt, servedAt: provenance.servedAt, delivery, fallback: false,
      source: "TSETMC Shareholder Changes", provenance, partial: true, failedInfo: 0, missingCount: symbols?.length ?? missingCount,
      sourceCompleteness: currentCoverage ? "selected-session" : "earlier-session-subset", nextCursor: null,
      warning: `${historicalWarning} ${unconfirmedSessionWarning} داده رسمی تغییرات با تاریخ منبع دریافت شد ولی اطلاعات تکمیلی قابل استفاده نبود (${error instanceof Error ? error.message : "خطای پردازش"}). نبود ردیف به معنای نبود خرید نیست.`.trim(),
    }, { headers: NO_STORE });
  }
}

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const cursorRaw = query.get("cursor") ?? 0, dateRaw = query.get("sourceDate"), fallbackRaw = query.get("fallback");
  if (!validCursor(cursorRaw) || !validSourceDate(dateRaw) || (fallbackRaw !== null && fallbackRaw !== "true" && fallbackRaw !== "false") ||
    (fallbackRaw === "true" && !dateRaw)) return Response.json({ error: "صفحه یا تاریخ منبع نامعتبر است." }, { status: 400, headers: NO_STORE });
  const cursor = Number(cursorRaw);
  return rowPage(cursor, undefined, Number(dateRaw) || undefined, fallbackRaw === "true");
}

export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "درخواست JSON معتبر لازم است." }, { status: 400, headers: NO_STORE }); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "درخواست نامعتبر است." }, { status: 400, headers: NO_STORE });
  if (body.view === "rows") {
    if (!Array.isArray(body.symbols) || body.symbols.some((value) => !validSymbol(value)) || body.symbols.length > 100 || !validSourceDate(body.sourceDate) || !validCursor(body.cursor ?? 0) ||
      (body.fallback !== undefined && typeof body.fallback !== "boolean") || (body.fallback === true && !body.sourceDate)) return Response.json({ error: "در هر درخواست حداکثر ۱۰۰ نماد معتبر مجاز است." }, { status: 400, headers: NO_STORE });
    const symbols = [...new Set((body.symbols as string[]).map(normalizeSymbol).filter(Boolean))];
    const cursor = Number(body.cursor ?? 0);
    if (!symbols.length || !Number.isInteger(cursor) || cursor < 0) return Response.json({ error: "نماد یا صفحه معتبر لازم است." }, { status: 400, headers: NO_STORE });
    return rowPage(cursor, symbols, Number(body.sourceDate) || undefined, body.fallback === true);
  }
  if (!Array.isArray(body.instruments) || body.instruments.length > 250 || body.instruments.some((item) => !item || typeof item !== "object" || !validSymbol(item.symbol) || !validCode(item.insCode))) return Response.json({ error: "فهرست نمادهای معتبر لازم است." }, { status: 400, headers: NO_STORE });
  const instruments: InstrumentRef[] = body.instruments.flatMap((item) => {
    if (!item || typeof item.symbol !== "string" || typeof item.insCode !== "string") return [];
    const symbol = normalizeSymbol(item.symbol), insCode = item.insCode.trim();
    return symbol && insCode ? [{ symbol, insCode }] : [];
  });
  if (!instruments.length) return Response.json({ error: "نماد معتبر لازم است." }, { status: 400, headers: NO_STORE });
  try {
    const { payload, fetchedAt, delivery, sourceHost, sourceDate: date, sourceAgeDays } = await changesPayload();
    const byCode = summarizeMajorIndividualHoldingChanges(extractMajorIndividualHoldingChanges(payload));
    const empty: MajorIndividualHoldingSummary = { buyCount: 0, sellCount: 0, buyShares: 0, sellShares: 0 };
    const complete = holderSessionCoverage(payload).completeForSelectedSession && date === lastClosedEquitySession();
    return Response.json({ summaries: Object.fromEntries(instruments.flatMap(({ symbol, insCode }) => byCode[insCode] ? [[symbol, byCode[insCode]]] : complete && sourceAgeDays <= 7 ? [[symbol, empty]] : [])),
      partial: !complete || sourceAgeDays > 7, sourceCompleteness: complete ? "selected-session" : "earlier-session-subset",
      sourceDate: date, fetchedAt, servedAt: new Date().toISOString(), delivery, fallback: false, source: "TSETMC Shareholder Changes", provenance: { kind: "official", host: sourceHost, sourceDate: date, sourceAgeDays, fetchedAt, currentSessionConfirmed: false },
      warning: sourceAgeDays > 7 ? `تاریخ داده رسمی ${date} بیش از هفت روز تقویمی پیش است؛ این پاسخ تأییدکننده جلسه کنونی نیست.`
        : !complete ? `تاریخ داده رسمی ${date} با آخرین جلسه عادی مورد انتظار تطبیق ندارد یا پوشش کامل آن تأیید نشده است.` : undefined,
    }, { headers: NO_STORE });
  } catch (error) {
    const snapshot = await loadVerifiedHolderSnapshot<HolderIncreaseRow, MajorIndividualHoldingSummary>();
    const summaries = Object.fromEntries(instruments.flatMap(({ symbol }) => snapshot.summaries[symbol] ? [[symbol, snapshot.summaries[symbol]]] : []));
    return Response.json({ summaries, sourceDate: snapshot.sourceDate, fetchedAt: snapshot.fetchedAt, source: snapshot.source, delivery: "bundled", fallback: true,
      partial: true, sourceCompleteness: "earlier-session-subset",
      warning: `داده پشتیبان تاریخی ${snapshot.sourceDate} جلسه معاملاتی کنونی را تأیید نمی‌کند.`,
      diagnostics: { outcome: "FALLBACK_BUNDLED", upstream: diagnosticOf(error) ?? null } }, { headers: NO_STORE });
  }
}
