"use client";

import { ChangeEvent, Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { compactSharesEn, groupHolderRowsBySymbol, signedSharesEn, toggleSymbolInSet } from "./lib/format";
import { fetchWithTimeout, readApiJson, withDeadline, loadBatches } from "./lib/request-lifecycle";
import { requestData } from "./lib/data-client";
import { inspectWorkerEdgeResponse, ScreenerWorkerCircuitBreaker } from "./lib/worker-edge-diagnostics";
import { defaultSymbols, normalizeSymbol } from "./default-symbols";
import DivergenceDetails from "./DivergenceDetails";
import { CopySymbol, OwnershipValue } from "./HolderControls";
import type { OwnershipValidation } from "./lib/holder-records";
import { holderFreshnessText, type HolderDelivery } from "./lib/holder-freshness";
import { browserMarket } from "./lib/browser-market";
import { browserQuotes } from "./lib/browser-quotes";
import { recoverDatedScreenerBatch } from "./lib/screener-direct-recovery";
import { preserveVerifiedRows, screenerQuoteSession, summarizeScreenerFreshness } from "./lib/screener-freshness";
import {
  markScreenerRowsStale, nextScreenerRefreshAt, screenerNeedsRefresh, screenerPendingVerification, screenerRowsSession,
  SCREENER_MAX_VERIFICATION_ATTEMPTS, SCREENER_VERIFICATION_RETRY_MS, type ScreenerVerificationState,
} from "./lib/screener-refresh";
import { readScreenerCache, writeScreenerCache } from "./lib/screener-cache";
import { recoverHighlightPrices } from "./lib/highlight-direct-recovery";
import { preserveDatedHolderRefresh } from "./lib/holder-increase-refresh";
import { expectedHighlightSession, isThursdayCommodityInstrument, primaryHighlightSession } from "./lib/highlight-session";
import { acceptMarketUniverse, holderErrorStatus, holderStatus, mergeMarketUniverse, pendingHolderSymbols, releaseProcessingHolders, retainHolderOnFailure, type HolderScanRecord } from "./lib/holder-scan-recovery";
import { lastClosedEquitySession, preserveHighlightRows, preferHolderSource, sourceSession } from "./lib/market-session";
import { HIGHLIGHT_BATCH_SIZE } from "./lib/official-details";
import { highlightCoverage, emptyDataMessage } from "./lib/data-coverage";
import {
  closingPriceGap,
  isSellQueueToPositive,
  parseSymbolList,
  subtractCalendarDays,
  symbolsForScope,
  type WatchlistScope,
  type CorporateAction,
  type MajorIndividualHoldingSummary,
  type MarketHighlight,
  type PeriodMetrics,
  type ScreenerRow,
} from "./lib/market";

// ─── Types ──────────────────────────────────────────────────────────────────
type Period = "3m" | "6m";
type MainTab = "3m" | "6m" | "highlights" | "holders" | "holderIncreases" | "selected";
type SourceKey = "haghighi" | "zarbanana" | "custom";
type DisplayMode = "all" | "peakDrop" | "rsiOversold" | "combined" | "selectedOnly" | "bullDiv" | "bearDiv" | "epsSectorPe" | "peBelowSector" | "holderBuys" | "holderSells";
type SortDirection = "asc" | "desc";
type MarketSymbol = { symbol: string; name: string; market: string };
type HolderRecord = HolderScanRecord;
type HolderIncreaseRow = {
  id: string;
  insCode: string;
  instrumentName: string;
  shareholderType: "شخص حقیقی";
  previousShares: number | null;
  currentShares: number;
  changeShares: number;
  changeEvidence: "snapshot" | "official";
  date: number;
  symbol: string;
  market: "بورس" | "فرابورس" | "بازار پایه" | "نامشخص";
  ownershipPct: number | null;
  ownership?: OwnershipValidation;
};
type ActionView = { row: ScreenerRow; actions: CorporateAction[]; period: Period };
type HighlightListRow = MarketHighlight & { primary: string; secondary: string; tag?: string };
type HolderChangeSummary = MajorIndividualHoldingSummary;
type HolderScope = WatchlistScope | "market";
type HoldingPage = { rows: HolderIncreaseRow[]; sourceDate: number | null; fetchedAt: string; partial?: boolean; fallback?: boolean; delivery?: HolderDelivery; sourceCompleteness?: string; nextCursor?: number | null; error?: string; warning?: string };
type HighlightSnapshot = { rows: MarketHighlight[]; fetchedAt?: string; latestDate?: number | null; partial?: boolean; clientTypeUnavailable?: boolean; missingCount?: number; error?: string };
const scopeLabel = (scope: HolderScope) => scope === "market" ? "کل بازار" : scope === "all" ? "کل واچ‌لیست" : scope === "haghighi" ? "حقیقی" : scope === "zarbanana" ? "زرد/نارنجی" : "دلخواه";

// ─── localStorage keys ──────────────────────────────────────────────────────
const K_HAGHIGHI = "ss-haghighi-v1";
const K_ZARBANANA = "ss-zarbanana-v1";
const K_CUSTOM = "ss-custom-v1";
const K_FAVS = "ss-favorites-v1";  const K_HOLDERS_CACHE_V2 = "ss-holders-v2";
const K_HOLDERS_CACHE = "ss-holders-v3";

const K_ACTIVE_SOURCE = "ss-active-source-v1";
const persistClientPreference = (key: string, value: string): boolean => {
  try { window.localStorage.setItem(key, value); return true; }
  catch { return false; }
};


const HOLDER_CACHE_AGE = 12 * 60 * 60 * 1000;
const HOLDER_BATCH_SIZE = 10;
const HOLDER_BATCH_PAUSE = 6_200;
// Production smoke (2026-10-24): a twenty-symbol base request repeatedly
// returned edge HTTP 503, while both ten-symbol halves returned HTTP 200.
// Keep the API's 20-symbol ceiling, but issue smaller, serial UI batches.
const SCREENER_BATCH_SIZE = 10;
type ScreenerApiPayload = {
  rows?: ScreenerRow[];
  latestDate?: number | null;
  fetchedAt?: string;
  error?: string;
};

// ─── Formatters ─────────────────────────────────────────────────────────────
const faN = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 });
const faI = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });
const faDT = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { dateStyle: "short", timeStyle: "short" });
const faMD = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "2-digit", day: "2-digit" });
const faCompact = new Intl.NumberFormat("fa-IR", { notation: "compact", maximumFractionDigits: 1 });

const compactShares = (v: number) => v >= 1e9 ? `${Math.round(v / 1e9 * 100) / 100}B` : v >= 1e6 ? `${Math.round(v / 1e6 * 100) / 100}M` : faN.format(v);
const fp = (v: number | null | undefined) => v === null || v === undefined || Number.isNaN(v) ? "—" : faN.format(v);
const pct = (v: number | null | undefined) => {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const s = v > 0 ? "+" : v < 0 ? "−" : "";
  return `${s}${faN.format(Math.abs(v))}٪`;
};
const drop = (v: number | null | undefined) => v === null || v === undefined || Number.isNaN(v) ? "—" : `${faN.format(Math.abs(v))}٪`;
const fmtDate = (v: string | number | null | undefined) => {
  if (!v) return "—";
  const r = String(v);
  if (!/^\d{8}$/.test(r)) return r;
  const d = new Date(Date.UTC(+r.slice(0, 4), +r.slice(4, 6) - 1, +r.slice(6, 8)));
  return faMD.format(d);
};

const expectedDate = () => {
  // The most recent Tehran trading day (Thursday/Friday closed). If that day is
  // today and the session has not closed yet, the previous session is expected.
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran", weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const v = Object.fromEntries(p.map((i) => [i.type, i.value]));
  const day = new Date(Date.UTC(+v.year, +v.month - 1, +v.day));
  const isClosedDay = (date: Date) => [4, 5].includes(date.getUTCDay());
  if (!isClosedDay(day) && +v.hour >= 13) return +`${v.year}${v.month}${v.day}`;
  do { day.setUTCDate(day.getUTCDate() - 1); } while (isClosedDay(day));
  return day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate();
};

const chunks = <T,>(a: T[], n: number) => { const r: T[][] = []; for (let i = 0; i < a.length; i += n) r.push(a.slice(i, i + n)); return r; };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mapConcurrent = async <T, R>(items: T[], concurrency: number, mapper: (item: T, index: number) => Promise<R>) => {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, worker));
  return results;
};

async function fetchServerHoldingRows(symbols?: string[], isCurrent: () => boolean = () => true, signal?: AbortSignal): Promise<HoldingPage> {
  const result: HoldingPage = { rows: [], sourceDate: null, fetchedAt: "", partial: false, fallback: false };
  const seen = new Set<string>();
  let pages = 0;
  const expires = Date.now() + 80_000;
  try {
  for (const batch of symbols ? chunks(symbols, 100) : [undefined]) {
    let cursor: number | null = 0;
    do {
      if (Date.now() >= expires) throw new Error("مهلت دریافت صفحات تمام شد.");
      if (++pages > 100) throw new Error("تعداد صفحات منبع بیش از حد مجاز است.");
      signal?.throwIfAborted();
      if (!isCurrent()) throw new Error("محدوده اسکن تغییر کرد.");
      const response = await requestData(`holder-increases?cursor=${cursor}&sourceDate=${result.sourceDate ?? ""}&fallback=${Boolean(result.fallback)}&_=${Date.now()}`, batch ? {
        signal,
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ view: "rows", symbols: batch, cursor, sourceDate: result.sourceDate, fallback: Boolean(result.fallback) }),
      } : { cache: "no-store", signal }, Math.min(45_000, expires - Date.now()));
      const data: HoldingPage = await readApiJson<HoldingPage>(response);
      if (!isCurrent()) throw new Error("محدوده اسکن تغییر کرد.");
      if (!response.ok || !Array.isArray(data.rows)) throw new Error(data.error || "پاسخ تغییرات سهامداران معتبر نیست.");
      if (result.sourceDate && data.sourceDate !== result.sourceDate) throw new Error("تاریخ پاسخ بخش‌های اسکن یکسان نیست؛ دوباره اسکن کنید.");
      result.sourceDate = data.sourceDate;
      result.fetchedAt = data.fetchedAt;
      result.partial ||= Boolean(data.partial);
      if (data.sourceCompleteness === "earlier-session-subset" || !result.sourceCompleteness) result.sourceCompleteness = data.sourceCompleteness;
      if (data.warning && !result.warning?.includes(data.warning)) result.warning = [result.warning, data.warning].filter(Boolean).join(" ").slice(0, 700);
      result.fallback ||= Boolean(data.fallback);
      result.delivery = result.fallback ? "bundled" : result.delivery === "cache" || data.delivery === "cache" ? "cache" : data.delivery;
      for (const row of data.rows) if (!seen.has(row.id)) { seen.add(row.id); result.rows.push(row); }
      const next = data.nextCursor ?? null;
      if (next !== null && (!Number.isInteger(next) || next <= cursor)) throw new Error("ادامه اسکن از منبع معتبر نیست.");
      cursor = next;
    } while (cursor !== null);
  }
  } catch (error) {
    if (!result.rows.length || !isCurrent() || signal?.aborted) throw error;
    result.partial = true;
    result.error = error instanceof Error ? error.message : "دریافت صفحات ناقص ماند.";
  }
  result.rows.sort((a, b) => b.changeShares - a.changeShares || a.symbol.localeCompare(b.symbol, "fa"));
  return result;
}

async function fetchHoldingRows(symbols?: string[], isCurrent: () => boolean = () => true, parent?: AbortSignal): Promise<HoldingPage> {
  return withDeadline((signal) => resolveHoldingRows(symbols, () => isCurrent() && !signal.aborted, signal), 120_000, parent);
}

async function resolveHoldingRows(symbols?: string[], isCurrent: () => boolean = () => true, signal?: AbortSignal): Promise<HoldingPage> {
  let server: HoldingPage | undefined;
  let serverError: unknown;
  try { server = await fetchServerHoldingRows(symbols, isCurrent, signal); } catch (error) { serverError = error; }
  if (!isCurrent()) throw new Error("محدوده اسکن تغییر کرد.");
  if (server && !server.fallback && !server.partial) return server;
  try {
    const direct = await withDeadline((directSignal) => browserMarket.holders(symbols, () => isCurrent() && !directSignal.aborted, directSignal), 35_000, signal);
    if (preferHolderSource(server, direct)) return direct;
  } catch { /* Retain the dated server snapshot when both networks fail. */ }
  if (!isCurrent()) throw new Error("محدوده اسکن تغییر کرد.");
  if (server) return server;
  if (serverError instanceof Error) throw serverError;
  throw new Error("دریافت تغییرات از سرور و مرورگر ناموفق بود؛ دوباره اسکن کنید.");
}

const gm = (row: ScreenerRow, p: Period) => p === "3m" ? row.three : row.six;
const hasDatedScreenerPrice = (row: ScreenerRow) =>
  Boolean(row.three || row.six || (row.priceQuote && sourceSession(row.priceQuote.sessionDate)
    && Number.isFinite(row.priceQuote.closeRial) && row.priceQuote.closeRial > 0));
const scanEst = (c: number) => !c ? "پس از دریافت فهرست بازار محاسبه می‌شود" : `حدود ${faI.format(Math.max(1, Math.ceil((Math.ceil(c / HOLDER_BATCH_SIZE) * HOLDER_BATCH_PAUSE) / 60_000)))} دقیقه`;

// ─── Sorting helpers ────────────────────────────────────────────────────────
const colVal = (row: ScreenerRow, key: string, period: Period) => {
  const m = gm(row, period);
  const vals: Record<string, number | string | null | undefined> = {
    symbol: row.symbol, startPrice: m?.startPrice, peakPrice: m?.peakPrice,
    currentPrice: m?.currentPrice ?? row.priceQuote?.closeRial, returnPct: m?.returnPct, drawdownPct: m?.drawdownPct,
    rsi: row.rsi, realHolders: row.realHolders,
    holderBuys: row.holderChange?.buyCount,
    epsSectorPeUpsidePct: row.valuation?.epsSectorPeUpsidePct,
    // Client swap: stock P/E lives in the P/E سهم column (its sort must
    // therefore prefer the SMALLER stock P/E, i.e. sort on the stock's own
    // P/E), while the P/E گروه column sorts on the group P/E. Both columns
    // previously sorted on (sectorPe - pe) which mixed the two concepts.
    peBelowSector: row.valuation ? row.valuation.pe : null,
    sectorPe: row.valuation ? row.valuation.sectorPe : null,
  };
  return vals[key] ?? null;
};

const cmpRows = (a: ScreenerRow, b: ScreenerRow, col: string, dir: SortDirection, period: Period) => {
  const av = colVal(a, col, period), bv = colVal(b, col, period);
  if (av === null || av === undefined) return bv === null || bv === undefined ? 0 : 1;
  if (bv === null || bv === undefined) return -1;
  const c = typeof av === "string" ? av.localeCompare(String(bv), "fa") : Number(av) - Number(bv);
  return dir === "asc" ? c : -c;
};

// ─── Sub-components ─────────────────────────────────────────────────────────
function SortBtn({ label, column, active, direction, onSort }: {
  label: string; column: string; active: string; direction: SortDirection; onSort: (c: string) => void;
}) {
  return <button className={`sort-button ${active === column ? "is-active" : ""}`} onClick={() => onSort(column)} type="button">
    <span>{label}</span>
    <span aria-hidden="true" className="sort-glyph">{active === column ? (direction === "asc" ? "↑" : "↓") : "↕"}</span>
  </button>;
}

function PriceCell({ value, sub }: { value?: number | null; sub?: string }) {
  return <><strong>{fp(value)}</strong>{sub && <small>{sub}</small>}</>;
}

function HolderChangeCell({ summary, loading, meta }: { summary?: HolderChangeSummary; loading: boolean; meta?: { date: number | null; fallback: boolean; delivery?: HolderDelivery } }) {
  if (!summary) return <span className="muted">{loading ? "…" : "—"}</span>;
  const sourceLabel = <small title={holderFreshnessText({ sourceDate: meta?.date, fallback: meta?.fallback, delivery: meta?.delivery }, expectedDate())}>{meta?.date ? fmtDate(meta.date) : "تاریخ منبع نامشخص"}{meta?.fallback ? " · پشتیبان تاریخی" : meta?.delivery === "cache" ? " · ذخیره‌شده" : ""}{meta?.date && meta.date < expectedDate() ? " · اطلاعات روز نیست" : ""}</small>;
  if (!summary.buyCount && !summary.sellCount) return <><span className="muted">—</span><small>تغییری در این داده ثبت نشده</small>{sourceLabel}</>;
  return <div className="holder-change-cell">
    <div>
      {summary.buyCount > 0 && <span className="holder-flow-badge buy" title={`${faI.format(summary.buyShares)} سهم افزایش`}>+{faI.format(summary.buyCount)}</span>}
      {summary.sellCount > 0 && <span className="holder-flow-badge sell" title={`${faI.format(summary.sellShares)} سهم کاهش`}>−{faI.format(summary.sellCount)}</span>}
    </div>
    {sourceLabel}
  </div>;
}

function HighlightCard({ number, title, subtitle, icon, rows, emptyText }: {
  number: string;
  title: string;
  subtitle: string;
  icon: string;
  rows: HighlightListRow[];
  emptyText: string;
}) {
  return <article className="highlight-card">
    <header><div className="highlight-heading"><span className="highlight-icon" aria-hidden="true">{icon}</span><div><h3>{title}</h3><p>{subtitle}</p></div></div><span className="highlight-number">{number}</span></header>
    <div className="table-wrap highlight-table"><table aria-label={title}><thead><tr><th>نماد</th><th>{number === "۱" ? "ارزش" : number === "۲" ? "حجم" : "ورود پول حقیقی"}</th><th>آخرین معامله (ریال)</th><th>پایانی (ریال)</th><th title="اختلاف آخرین معامله نسبت به قیمت پایانی همان روز: (آخرین معامله − پایانی) ÷ پایانی × ۱۰۰">اختلاف (%)</th><th>تاریخ</th></tr></thead><tbody>{rows.map((row) => <tr key={row.symbol}>
      <td><span className="symbol-date-line"><strong>{row.symbol}</strong><CopySymbol symbol={row.symbol} /><small className="row-date" aria-label={`تاریخ داده ${fmtDate(row.sessionDate)}`}>{fmtDate(row.sessionDate)}</small></span><small>{row.name}</small></td>
      <td><strong>{row.primary}</strong></td>
      <td><strong>{fp(row.priceLast)}</strong><small className={row.lastChangePct >= 0 ? "positive" : "negative"}>{pct(row.lastChangePct)}</small></td>
      <td><strong>{fp(row.priceClose)}</strong><small className={row.closeChangePct >= 0 ? "positive" : "negative"}>{pct(row.closeChangePct)}</small></td>
      <td><strong className={row.priceLast >= row.priceClose ? "positive" : "negative"}>{pct(closingPriceGap(row.priceLast, row.priceClose)?.percent)}</strong><small>{fp(closingPriceGap(row.priceLast, row.priceClose)?.rial)} ریال</small></td>
      <td><small className="row-date">{fmtDate(row.sessionDate)}</small></td>
    </tr>)}</tbody></table></div>
    {!rows.length && <div className="highlight-empty">{emptyText}</div>}
  </article>;
}

function ReversalHighlightCard({ rows, emptyText }: { rows: MarketHighlight[]; emptyText: string }) {
  return <article className="highlight-card reversal-highlight-card">
    <header><div className="highlight-heading"><span className="highlight-icon" aria-hidden="true">↺</span><div><h3>از صف فروش به مثبت</h3><p>لمس دقیق کف مجاز همان روز، آخرین مثبت و پایانی منفی</p></div></div><span className="highlight-number">۴</span></header>
    <div className="reversal-table-head" aria-hidden="true">
      <span>نماد</span><span>آخر (ریال)</span><span>پایانی (ریال)</span><span title="اختلاف آخرین معامله نسبت به قیمت پایانی همان روز: (آخرین معامله − پایانی) ÷ پایانی × ۱۰۰">اختلاف (%)</span>
    </div>
    <ol>{rows.map((row) => <li key={row.symbol}>
      <span className="reversal-symbol" title={`تاریخ ${fmtDate(row.sessionDate)} · کمترین معامله ${fp(row.priceMin)} · کف مجاز ${fp(row.allowedMin)}`}><strong>{row.symbol}</strong><CopySymbol symbol={row.symbol} /><small className="reversal-date">{fmtDate(row.sessionDate)}</small></span>
      <span className="reversal-value"><strong>{fp(row.priceLast)}</strong><small className="positive">{pct(row.lastChangePct)}</small></span>
      <span className="reversal-value"><strong>{fp(row.priceClose)}</strong><small className="negative">{pct(row.closeChangePct)}</small></span>
      <span className="reversal-value">{pct(closingPriceGap(row.priceLast, row.priceClose)?.percent)}<small>{fp(closingPriceGap(row.priceLast, row.priceClose)?.rial)} ریال</small></span>
    </li>)}</ol>
    {!rows.length && <div className="highlight-empty">{emptyText}</div>}
  </article>;
}

// ─── Symbol parsing for TXT with order preservation ─────────────────────────
const parseTxtSymbols = parseSymbolList;

// ══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ══════════════════════════════════════════════════════════════════════════════
export default function ScreenerClient() {
  const [storageWriteFailed, setStorageWriteFailed] = useState(false);
  const persistPreference = (key: string, value: string) => {
    const saved = persistClientPreference(key, value);
    if (!saved) setStorageWriteFailed(true);
    return saved;
  };
  // ── Tab state ──
  const [activeTab, setActiveTab] = useState<MainTab>("3m");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("all");
  const [peakDropPeriod, setPeakDropPeriod] = useState<"1m" | "2m" | "3m">("3m");

  // ── Active source (which symbol list to show in 3m/6m tabs) ──
  const [activeSource, setActiveSource] = useState<SourceKey>("haghighi");
  const [highlightScope, setHighlightScope] = useState<WatchlistScope>("haghighi");
  const [increaseScope, setIncreaseScope] = useState<HolderScope>("market");
  const [holderIncreasesOpen, setHolderIncreasesOpen] = useState<Set<string>>(new Set());
  const [highlightOpenGroups, setHighlightOpenGroups] = useState<Set<string>>(new Set());
  const [showAllHighlightHolders, setShowAllHighlightHolders] = useState(false);
  const [highlightsError, setHighlightsError] = useState("");
  const [increaseError, setIncreaseError] = useState("");
  const [increaseScanned, setIncreaseScanned] = useState(false);

  // ── Symbol lists ──
  const [haghighiSymbols, setHaghighiSymbols] = useState<string[]>(defaultSymbols);
  const [zarbananaSymbols, setZarbananaSymbols] = useState<string[]>([]);
  const [customSymbols, setCustomSymbols] = useState<string[]>([]);

  // ── Data fetched per source ──
  const [haghighiRows, setHaghighiRows] = useState<ScreenerRow[]>([]);
  const [zarbananaRows, setZarbananaRows] = useState<ScreenerRow[]>([]);
  const [customRows, setCustomRows] = useState<ScreenerRow[]>([]);

  // ── Shared favorites ──
  const [sharedFavs, setSharedFavs] = useState<Set<string>>(new Set());
  const [favoriteFetchedRows, setFavoriteFetchedRows] = useState<ScreenerRow[]>([]);
  const [favoriteLoading, setFavoriteLoading] = useState(false);
  const [favoriteError, setFavoriteError] = useState("");

  // ── Modal states ──
  const [mgrOpen, setMgrOpen] = useState<null | SourceKey>(null);
  const [mgrDraft, setMgrDraft] = useState("");

  // ── Edit drafts for each source modal ──
  const [haghighiDraft, setHaghighiDraft] = useState(defaultSymbols.join("\n"));
  const [zarbananaDraft, setZarbananaDraft] = useState("");
  const [customDraft, setCustomDraft] = useState("");

  // ── Loading states ──
  const [sourceLoading, setSourceLoading] = useState<Partial<Record<SourceKey, boolean>>>({});
  const [sourceErrors, setSourceErrors] = useState<Partial<Record<SourceKey, string>>>({});
  const loading = Boolean(sourceLoading[activeSource]);
  const [, setNotice] = useState("در حال آماده‌سازی فهرست نمادها…");
  const [holderScanning, setHolderScanning] = useState(false);
  const [holderScope, setHolderScope] = useState("");
  const [holderProgress, setHolderProgress] = useState({ done: 0, total: 0 });

  // ── Holder data ──
  const [holderCounts, setHolderCounts] = useState<Record<string, number | null>>({});
  const [holderMeta, setHolderMeta] = useState<Record<string, HolderRecord>>({});
  const [marketUniverse, setMarketUniverse] = useState<MarketSymbol[]>([]);
  const [marketUniversePartial, setMarketUniversePartial] = useState(false);
  const [marketLoading, setMarketLoading] = useState(false);
  const [holderIncreaseRows, setHolderIncreaseRows] = useState<HolderIncreaseRow[]>([]);
  const [holderIncreaseLoading, setHolderIncreaseLoading] = useState(false);
  const [holderIncreaseDate, setHolderIncreaseDate] = useState<number | null>(null);
  const [holderIncreaseUpdatedAt, setHolderIncreaseUpdatedAt] = useState<Date | null>(null);
  const [holderIncreasePartial, setHolderIncreasePartial] = useState(false);
  const [holderIncreaseFallback, setHolderIncreaseFallback] = useState(false);
  const [holderIncreaseDelivery, setHolderIncreaseDelivery] = useState<HolderDelivery | undefined>();
  const [holderIncreaseSearch, setHolderIncreaseSearch] = useState("");
  const [holderChangeSummaries, setHolderChangeSummaries] = useState<Record<string, HolderChangeSummary>>({});
  const [holderChangeMeta, setHolderChangeMeta] = useState<Record<string, { date: number | null; fallback: boolean; delivery?: HolderDelivery }>>({});
  const [pendingHolderChanges, setPendingHolderChanges] = useState(0);
  const holderChangesLoading = pendingHolderChanges > 0;
  const [highlights, setHighlights] = useState<MarketHighlight[]>([]);
  const [highlightSummary, setHighlightSummary] = useState("");
  const [highlightsLoading, setHighlightsLoading] = useState(false);
  const [highlightsUpdatedAt, setHighlightsUpdatedAt] = useState<Date | null>(null);
  const [highlightSessionDate, setHighlightSessionDate] = useState<number | null>(null);
  const [highlightClientTypeUnavailable, setHighlightClientTypeUnavailable] = useState(false);
  const [highlightHoldings, setHighlightHoldings] = useState<HoldingPage | null>(null);
  const [highlightHoldingsLoading, setHighlightHoldingsLoading] = useState(false);
  const [highlightHoldingsError, setHighlightHoldingsError] = useState("");
  const [holderSortCol, setHolderSortCol] = useState("realHolders");
  const [holderSortDir, setHolderSortDir] = useState<SortDirection>("desc");
  const [marketSearch, setMarketSearch] = useState("");
  const [sourceMeta, setSourceMeta] = useState<Partial<Record<SourceKey, { latestDate: number | null; updatedAt: Date }>>>({});
  const latestDate = sourceMeta[activeSource]?.latestDate ?? null;
  const expectedSession = expectedDate();
  const behindExpected = Boolean(expectedSession && latestDate && latestDate < expectedSession);
  const lastUpdated = sourceMeta[activeSource]?.updatedAt ?? null;
  const noticeSourceSymbols = activeSource === "haghighi" ? haghighiSymbols : activeSource === "zarbanana" ? zarbananaSymbols : customSymbols;
  const noticeSourceRows = activeSource === "haghighi" ? haghighiRows : activeSource === "zarbanana" ? zarbananaRows : customRows;
  const noticeScopeCount = symbolsForScope({ haghighi: haghighiSymbols, zarbanana: zarbananaSymbols, custom: customSymbols }, highlightScope).length;
  // Notifications are derived from the ACTIVE tab. Asynchronous work from a
  // previously visited tab must never overwrite the user's current status.
  const activeNotice = activeTab === "3m" || activeTab === "6m"
    ? sourceLoading[activeSource] ? `در حال دریافت و بررسی سابقه قیمت ${faI.format(noticeSourceSymbols.length)} نماد…`
      : sourceErrors[activeSource] ? `دریافت اطلاعات این فهرست ناقص است: ${sourceErrors[activeSource]}`
        : noticeSourceRows.length ? behindExpected
          ? `آخرین جلسه معتبر این فهرست ${fmtDate(latestDate)} است؛ تازگی قیمت جداگانه بررسی می‌شود.`
          : `اطلاعات ${faI.format(noticeSourceRows.length)} نماد فهرست آماده است.`
          : "برای دریافت داده‌های این فهرست، بروزرسانی اطلاعات را بزنید."
    : activeTab === "highlights"
      ? highlightsLoading ? `در حال بروزرسانی رتبه‌بندی ${faI.format(noticeScopeCount)} نماد…`
        : highlightsError ? `رتبه‌بندی ناقص است: ${highlightsError}`
          : highlightSummary || (highlightsUpdatedAt ? `رتبه‌بندی ${faI.format(highlights.length)} نماد دریافت شد؛ پوشش داده و تاریخ هر کارت را بررسی کنید.`
            : "برای دریافت رتبه‌بندی، بروزرسانی رتبه‌بندی‌ها را بزنید.")
    : activeTab === "holders"
      ? marketLoading ? "در حال دریافت فهرست نمادهای بازار…"
        : holderScanning ? `اسکن حقیقی‌های عمده: ${faI.format(holderProgress.done)} از ${faI.format(holderProgress.total)} نماد`
          : marketUniverse.length ? `فهرست ${faI.format(marketUniverse.length)} نماد دریافت شده؛ برای ادامه اسکن روی دکمه مربوط کلیک کنید.`
            : "برای شمارش حقیقی‌های عمده، اسکن کل بازار را بزنید."
    : activeTab === "holderIncreases"
      ? holderIncreaseLoading ? "در حال بررسی تغییرات رسمی سهامداران…"
        : increaseError ? `تغییرات سهامداران ناقص است: ${increaseError}`
          : increaseScanned ? holderIncreaseFallback
            ? "داده تاریخی پشتیبان نمایش داده شده است؛ خرید روز جاری تأیید نمی‌شود."
            : `تغییرات ${faI.format(holderIncreaseRows.length)} سهامدار دریافت شد؛ تاریخ منبع را بررسی کنید.`
            : "برای بررسی افزایش سهامداران، محدوده اسکن را انتخاب کنید."
    : `در واچ‌لیست ${faI.format(sharedFavs.size)} نماد منتخب دارید.`;

  // ── Sort state ──
  const [sortCol, setSortCol] = useState("symbol");
  const [sortDir, setSortDir] = useState<SortDirection>("asc");
  const [searchDraft, setSearchDraft] = useState("");

  // ── Action modal ──
  const [divergenceView, setDivergenceView] = useState<ScreenerRow | null>(null);
  const [actionView, setActionView] = useState<ActionView | null>(null);
  const [showWelcome, setShowWelcome] = useState(true);
  const [hydrated, setHydrated] = useState(false);

  // ── Refs ──
  const fileInputRef = useRef<HTMLInputElement>(null);
  const autoLoaded = useRef(false);
  const highlightRequest = useRef(0);
  const increaseRequest = useRef(0);
  const highlightCache = useRef(new Map<string, HighlightSnapshot>());
  const increaseCache = useRef(new Map<string, HoldingPage>());
  const sourceControllers = useRef<Partial<Record<SourceKey, AbortController>>>({});
  const sourceRequests = useRef<Record<SourceKey, number>>({ haghighi: 0, zarbanana: 0, custom: 0 });
  const activeSourceRef = useRef(activeSource);
  useEffect(() => { activeSourceRef.current = activeSource; }, [activeSource]);
  const holderScanToken = useRef(0);
  const manualController = useRef<AbortController | null>(null);
  const highlightController = useRef<AbortController | null>(null);
  const increaseController = useRef<AbortController | null>(null);
  const holderChangeRequest = useRef(0);
  const holderSymbolRequests = useRef<Record<string, number>>({});
  const holderCountsRef = useRef<Record<string, number | null>>({});
  const holderCacheFresh = useRef(false);
  const holderMetaRef = useRef<Record<string, HolderRecord>>({});
  // Automatic verification attempts are counted per source and expected
  // session, so an open page retries a bounded number of times and then waits
  // for the next session instead of polling forever.
  const verificationRef = useRef<Partial<Record<SourceKey, ScreenerVerificationState>>>({});
  const [verificationState, setVerificationState] = useState<Partial<Record<SourceKey, ScreenerVerificationState>>>({});
  const recordVerificationAttempt = (src: SourceKey) => {
    const session = lastClosedEquitySession();
    const previous = verificationRef.current[src];
    const next: ScreenerVerificationState = previous && previous.session === session
      ? { session, attempts: previous.attempts + 1, lastAttemptAt: Date.now() }
      : { session, attempts: 1, lastAttemptAt: Date.now() };
    verificationRef.current = { ...verificationRef.current, [src]: next };
    setVerificationState(verificationRef.current);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // HELPERS for source management
  // ══════════════════════════════════════════════════════════════════════════
  const getSourceSymbols = useCallback((src: SourceKey) => src === "haghighi" ? haghighiSymbols : src === "zarbanana" ? zarbananaSymbols : customSymbols, [haghighiSymbols, zarbananaSymbols, customSymbols]);
  const getSourceRows = useCallback((src: SourceKey) => src === "haghighi" ? haghighiRows : src === "zarbanana" ? zarbananaRows : customRows, [haghighiRows, zarbananaRows, customRows]);
  const getScopeSymbols = (scope: WatchlistScope) => symbolsForScope({ haghighi: haghighiSymbols, zarbanana: zarbananaSymbols, custom: customSymbols }, scope);
  const sourceLabel = (src: SourceKey) => src === "haghighi" ? "حقیقی" : src === "zarbanana" ? "زرد/نارنجی" : "دلخواه";
  const sourceCount = (src: SourceKey) => (src === "haghighi" ? haghighiSymbols : src === "zarbanana" ? zarbananaSymbols : customSymbols).length;

  // ══════════════════════════════════════════════════════════════════════════
  // HYDRATION (load from localStorage)
  // ══════════════════════════════════════════════════════════════════════════
  const loadList = useCallback((key: string, fallback: string[]): string[] => {
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) return fallback;
      const arr = JSON.parse(raw) as string[];
      if (Array.isArray(arr) && arr.length) return arr;
    } catch { /* ignore */ }
    return fallback;
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const hs = loadList(K_HAGHIGHI, defaultSymbols);
      const zs = loadList(K_ZARBANANA, []);
      const cs = loadList(K_CUSTOM, []);
      const favs = loadList(K_FAVS, []);
      let savedSrc: SourceKey | null = null;
      try { savedSrc = window.localStorage.getItem(K_ACTIVE_SOURCE) as SourceKey | null; } catch { /* storage may be disabled */ }

      setHaghighiSymbols(hs);
      setHaghighiDraft(hs.join("\n"));
      setZarbananaSymbols(zs);
      setZarbananaDraft(zs.join("\n"));
      setCustomSymbols(cs);
      setCustomDraft(cs.join("\n"));
      setSharedFavs(new Set(favs));
      if (savedSrc && ["haghighi", "zarbanana", "custom"].includes(savedSrc)) setActiveSource(savedSrc);
      // A reload of the same list and session starts from the stored snapshot.
      for (const [src, list] of [["haghighi", hs], ["zarbanana", zs], ["custom", cs]] as [SourceKey, string[]][]) {
        const cached = readScreenerCache(window.localStorage, src, list);
        if (!cached) continue;
        if (src === "haghighi") setHaghighiRows(cached.rows);
        else if (src === "zarbanana") setZarbananaRows(cached.rows);
        else setCustomRows(cached.rows);
        if (cached.verification) verificationRef.current[src] = cached.verification;
        setSourceMeta((current) => ({ ...current, [src]: { latestDate: cached.session, updatedAt: new Date(cached.savedAt) } }));
      }
      setVerificationState({ ...verificationRef.current });

      try {
        const raw = window.localStorage.getItem(K_HOLDERS_CACHE_V2);
        if (raw) {
          const obj = JSON.parse(raw) as { updatedAt?: number; counts?: Record<string, number | null> };
          if (obj.counts && typeof obj.counts === "object") {
            holderCountsRef.current = obj.counts;
            setHolderCounts(obj.counts);
            const counts = obj.counts;
            holderCacheFresh.current = Date.now() - Number(obj.updatedAt ?? 0) < HOLDER_CACHE_AGE;
            if (counts && typeof counts === "object") {
              const meta: Record<string, HolderRecord> = {};
              for (const [k, v] of Object.entries(counts)) {
                if (typeof v === "number") meta[k] = { count: v, status: v === 0 ? "verified-zero" : "verified", sourceDate: null, retrievedAt: null, delivery: "cache", partial: true };
                else meta[k] = { count: null, status: "unavailable", sourceDate: null, retrievedAt: null, delivery: "cache", partial: true };
              }
              setHolderMeta(meta);
            }
          }
        }
      } catch { /* ignore */ }
      try {
        const raw = window.localStorage.getItem(K_HOLDERS_CACHE);
        if (raw) {
          const obj = JSON.parse(raw) as { updatedAt?: number; meta?: Record<string, HolderRecord> };
          if (obj.meta && typeof obj.meta === "object") {
            holderMetaRef.current = obj.meta;
            setHolderMeta(obj.meta);
            const counts = Object.fromEntries(Object.entries(obj.meta).map(([symbol, record]) => [symbol, record.count]));
            holderCountsRef.current = counts;
            setHolderCounts(counts);
          }
        }
      } catch { /* ignore */ }
      setHydrated(true);
    }, 0);
    return () => window.clearTimeout(t);
  }, [loadList]);

  useEffect(() => { holderCountsRef.current = holderCounts; }, [holderCounts]);
  useEffect(() => { holderMetaRef.current = holderMeta; }, [holderMeta]);

  useEffect(() => {
    const controllers = sourceControllers.current;
    const requests = sourceRequests.current;
    return () => {
      for (const src of ["haghighi", "zarbanana", "custom"] as SourceKey[]) { requests[src]++; controllers[src]?.abort(); }
      // These are operation counters, intentionally read at cleanup time.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      highlightRequest.current++; increaseRequest.current++; holderScanToken.current++;
      manualController.current?.abort(); highlightController.current?.abort(); increaseController.current?.abort();
    };
  }, []);


  // ══════════════════════════════════════════════════════════════════════════
  // AUTO-LOAD on first render
  // ══════════════════════════════════════════════════════════════════════════
  useEffect(() => {
    if (!hydrated || autoLoaded.current) return;
    autoLoaded.current = true;
    const symbols = getSourceSymbols(activeSource);
    if (!symbols.length) return;
    const rows = getSourceRows(activeSource);
    const now = new Date();
    // The stored snapshot of the same session is shown as-is; the list is read
    // again only when it is missing, from another session, or still unverified.
    if (!screenerNeedsRefresh(rows, now, { loadedSession: screenerRowsSession(rows, now), verification: verificationRef.current[activeSource] })) return;
    void fetchSourceData(activeSource, symbols);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, activeSource, getSourceSymbols, getSourceRows]);

  // One timer for the next 13:05 Tehran session close. A visibility change is a
  // second chance to run the same decision when the browser throttled it, so
  // returning to the tab alone never refetches data that is already final.
  useEffect(() => {
    if (!hydrated || (activeTab !== "3m" && activeTab !== "6m")) return;
    const src = activeSource;
    const symbols = getSourceSymbols(src);
    const attempt = () => {
      if (document.visibilityState !== "visible" || sourceLoading[src] || !symbols.length) return;
      const rows = getSourceRows(src);
      const now = new Date();
      if (!screenerNeedsRefresh(rows, now, { loadedSession: screenerRowsSession(rows, now), verification: verificationRef.current[src] })) return;
      void fetchSourceData(src, symbols);
    };
    const now = new Date();
    const rows = getSourceRows(src);
    const expected = lastClosedEquitySession(now);
    const state = verificationRef.current[src];
    let at = nextScreenerRefreshAt(now).getTime();
    if (rows.length && screenerPendingVerification(rows, expected, now).length &&
      (!state || state.session !== expected || state.attempts < SCREENER_MAX_VERIFICATION_ATTEMPTS)) {
      const retryAt = state && state.session === expected ? state.lastAttemptAt + SCREENER_VERIFICATION_RETRY_MS : now.getTime();
      at = Math.min(at, retryAt);
    }
    const timer = window.setTimeout(attempt, Math.max(1_000, at - now.getTime()));
    document.addEventListener("visibilitychange", attempt);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", attempt);
    };
  // fetchSourceData is reached through the current rows/attempts deps below; its
  // request counter and AbortController already serialize/cancel refreshes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, activeTab, activeSource, sourceLoading, haghighiRows, zarbananaRows, customRows, verificationState, getSourceSymbols, getSourceRows]);

  // One snapshot per source, symbol list and session for the next page load.
  useEffect(() => {
    if (!hydrated) return;
    const timer = window.setTimeout(() => {
      for (const [src, list, rows] of [
        ["haghighi", haghighiSymbols, haghighiRows],
        ["zarbanana", zarbananaSymbols, zarbananaRows],
        ["custom", customSymbols, customRows],
      ] as [SourceKey, string[], ScreenerRow[]][]) {
        const session = screenerRowsSession(rows);
        if (!session) continue;
        writeScreenerCache(window.localStorage, src, list, { session, savedAt: Date.now(), verification: verificationRef.current[src] ?? null, rows });
      }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [hydrated, haghighiRows, zarbananaRows, customRows, haghighiSymbols, zarbananaSymbols, customSymbols]);

  // ══════════════════════════════════════════════════════════════════════════
  // DATA FETCHING
  // ══════════════════════════════════════════════════════════════════════════
  async function fetchSourceData(src: SourceKey, symbols: string[]) {
    const requestId = ++sourceRequests.current[src];
    sourceControllers.current[src]?.abort();
    const controller = new AbortController();
    sourceControllers.current[src] = controller;
    setSourceErrors((current) => ({ ...current, [src]: "" }));
    const previous = new Map(getSourceRows(src).map((row) => [row.symbol, row]));
    // Every officially confirmed row keeps its price across refreshes that only
    // return unverified base rows for the same expected session.
    const verifiedRows = new Map<string, ScreenerRow>([...previous.values()]
      .filter((row) => row.quoteVerified === true)
      .map((row) => [normalizeSymbol(row.symbol), row] as const));
    let liveRows: ScreenerRow[] = [];
    const publish = (incoming: ScreenerRow[]) => {
      if (sourceRequests.current[src] !== requestId || controller.signal.aborted) return;
      liveRows = preserveVerifiedRows(incoming, verifiedRows);
      if (src === "haghighi") setHaghighiRows(liveRows);
      else if (src === "zarbanana") setZarbananaRows(liveRows);
      else setCustomRows(liveRows);
      const dates = liveRows.map((row) => Number(row.priceQuote?.sessionDate ?? row.three?.currentDate ?? 0)).filter(Boolean);
      if (dates.length) setSourceMeta((current) => ({ ...current, [src]: { latestDate: Math.max(...dates), updatedAt: new Date() } }));
    };
    // A row confirmed one at a time is merged into the visible list; a partial
    // progress snapshot never replaces the other rows.
    const publishVerified = (updated: ScreenerRow[]) => {
      if (!liveRows.length) return;
      const bySymbol = new Map(liveRows.map((row) => [normalizeSymbol(row.symbol), row]));
      for (const row of updated) if (row.quoteVerified === true) bySymbol.set(normalizeSymbol(row.symbol), row);
      publish(symbols.flatMap((symbol) => bySymbol.get(normalizeSymbol(symbol)) ?? []));
    };
    if (!symbols.length) {
      setSourceLoading((current) => ({ ...current, [src]: false }));
      setSourceMeta((current) => ({ ...current, [src]: undefined }));
      if (src === "haghighi") setHaghighiRows([]);
      else if (src === "zarbanana") setZarbananaRows([]);
      else setCustomRows([]);
      return;
    }
    recordVerificationAttempt(src);
    setSourceLoading((current) => ({ ...current, [src]: true }));
    setNotice(`در حال دریافت سابقه قیمت ${faI.format(symbols.length)} نماد ${sourceLabel(src)}…`);
    try {
      const requestBatches = chunks(symbols, SCREENER_BATCH_SIZE);
      const progressive = new Map<string, ScreenerRow>();
      const workerBreaker = new ScreenerWorkerCircuitBreaker();
      let edgeRecoveryCount = 0;
      const { results, expired } = await loadBatches<ScreenerApiPayload>(requestBatches, async (batch, signal, attempt) => {
        if (workerBreaker.shouldTryDirectFirst()) {
          try {
            return await recoverDatedScreenerBatch(batch, signal);
          } catch {
            // If direct CORS stops working, recover the normal Worker path
            // immediately; do not abandon the symbol or fabricate a price.
            workerBreaker.directSourceFailed();
          }
        }
        let response: Response;
        try {
          // Leave enough of the batch's deadline for direct-source recovery.
          response = await requestData(`screener?_=${Date.now()}&attempt=${attempt + 1}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: batch, baseOnly: true }), signal,
          }, 18_000);
        } catch (error) {
          if (signal.aborted) throw error;
          const recovered = await recoverDatedScreenerBatch(batch, signal);
          // A timed-out/transport-failed Worker can otherwise waste 18s on
          // every remaining batch, even after dated browser CORS succeeds.
          workerBreaker.recoveredFromWorkerFailure();
          edgeRecoveryCount++;
          return recovered;
        }
        if ([502, 503, 504].includes(response.status)) {
          // Capture the actual Cloudflare 1xxx code and Ray ID when present,
          // rather than guessing the cause of an HTTP 503. No symbol lists,
          // request bodies, cookies or raw response content are logged.
          const edge = await inspectWorkerEdgeResponse(response);
          console.warn("screener_worker_recovery", edge);
          // An HTML 503 from the edge used to discard a whole 20-symbol batch.
          // Recover the same dated history in the browser via the provider's
          // permitted CORS API, using the identical 90/180 analysis routines.
          const recovered = await recoverDatedScreenerBatch(batch, signal);
          edgeRecoveryCount++;
          workerBreaker.recoveredFromWorkerFailure();
          return recovered;
        }
        let data: ScreenerApiPayload;
        try { data = await readApiJson<ScreenerApiPayload>(response); }
        catch (error) {
          if (!response.ok && response.status < 500) throw error;
          const recovered = await recoverDatedScreenerBatch(batch, signal);
          workerBreaker.recoveredFromWorkerFailure();
          edgeRecoveryCount++;
          return recovered;
        }
        if (!response.ok) throw new Error(data.error || `سرویس فیلتر HTTP ${response.status} برگرداند.`);
        if (!Array.isArray(data.rows)) {
          const recovered = await recoverDatedScreenerBatch(batch, signal);
          workerBreaker.recoveredFromWorkerFailure();
          edgeRecoveryCount++;
          return recovered;
        }
        const received = new Set(data.rows.filter(hasDatedScreenerPrice).map((row) => normalizeSymbol(row.symbol)));
        if (received.size) workerBreaker.workerSucceeded();
        const unresolved = batch.filter((symbol) => !received.has(normalizeSymbol(symbol)));
        if (unresolved.length) {
          try {
            const recovery = await recoverDatedScreenerBatch(unresolved, signal);
            if (!received.size) {
              // HTTP 200 with no usable quotes is NOT proof of a healthy
              // Worker. Prefer independently recovered dated data for this run.
              workerBreaker.recoveredFromWorkerFailure();
              edgeRecoveryCount++;
            }
            const recovered = new Map(recovery.rows.filter(hasDatedScreenerPrice).map((row) => [normalizeSymbol(row.symbol), row]));
            return { ...data, rows: batch.map((symbol) => data.rows!.find((row) => normalizeSymbol(row.symbol) === normalizeSymbol(symbol) && hasDatedScreenerPrice(row)) ?? recovered.get(normalizeSymbol(symbol)) ?? data.rows!.find((row) => normalizeSymbol(row.symbol) === normalizeSymbol(symbol))!).filter(Boolean) };
          } catch { /* Existing valid rows remain visible when the fallback is unavailable. */ }
        }
        if (!data.rows.some(hasDatedScreenerPrice)) throw new Error(data.error || "داده قابل استفاده از منبع دریافت نشد.");
        return data;
      }, { signal: controller.signal, onSuccess: (batch, data) => {
        for (const row of data.rows ?? []) if (batch.includes(normalizeSymbol(row.symbol)) && hasDatedScreenerPrice(row)) progressive.set(normalizeSymbol(row.symbol), row);
        publish(symbols.flatMap((symbol) => progressive.has(symbol) ? [progressive.get(symbol)!] : previous.has(symbol) ? [previous.get(symbol)!] : []));
      }, concurrency: 1, pauseMs: 350, retryMs: 1_800, budgetMs: 260_000 });

      const successful = results.filter((result) => result.data?.rows?.length);
      if (!successful.length) throw new Error(results[0]?.error || "هیچ پاسخی از سرور دریافت نشد.");

      const rowBySymbol = new Map<string, ScreenerRow>();
      for (const result of successful) {
        for (const row of result.data!.rows!) if (hasDatedScreenerPrice(row)) rowBySymbol.set(normalizeSymbol(row.symbol), row);
      }
      const failed = new Map(results.filter((result) => result.error).flatMap((result) => result.batch.map((symbol) => [normalizeSymbol(symbol), result.error!] as const)));
      const returnedErrors = new Map(successful.flatMap(result => (result.data?.rows ?? []).filter(row => !hasDatedScreenerPrice(row)).map(row => [normalizeSymbol(row.symbol), row] as const)));
      const retained = symbols.filter((symbol) => !rowBySymbol.has(normalizeSymbol(symbol)) && previous.has(normalizeSymbol(symbol))).length;
      let rows: ScreenerRow[] = symbols.map((symbol) => rowBySymbol.get(normalizeSymbol(symbol)) ?? (previous.has(normalizeSymbol(symbol)) ? {
        ...previous.get(normalizeSymbol(symbol))!, status: "warning" as const,
        note: "دریافت تازه ناموفق بود؛ داده قبلی با تاریخ همان جلسه نمایش داده می‌شود.",
      } : undefined) ?? returnedErrors.get(normalizeSymbol(symbol)) ?? {
        symbol,
        rsi: null,
        realHolders: null,
        three: null,
        six: null,
        actions: [],
        status: "error" as const,
        note: failed.get(normalizeSymbol(symbol)) || "داده این نماد دریافت نشد.",
      });
      if (sourceRequests.current[src] !== requestId) return;
      if (activeSourceRef.current === src) setNotice("در حال تطبیق تاریخ و قیمت تک‌تک نمادها با منبع رسمی…");
      publish(rows);
      // Official enrichment is optional and has its own finite budget. Base
      // dated data is already visible while it runs.
      let verificationBudgetExpired = false;
      try {
        rows = await withDeadline((signal) => browserQuotes.refresh(rows, () => sourceRequests.current[src] === requestId && !signal.aborted, signal, publishVerified), 25_000, controller.signal);
      } catch { verificationBudgetExpired = true; /* every row confirmed before the deadline stays published */ }
      rows = preserveVerifiedRows(rows, verifiedRows);
      if (sourceRequests.current[src] !== requestId) return;
      if (expired || retained || rowBySymbol.size < symbols.length) setSourceErrors((current) => ({ ...current, [src]: "دریافت ناقص ماند؛ داده‌های موجود با تاریخ منبع حفظ شدند. برای تکمیل دوباره تلاش کنید." }));
      else if (edgeRecoveryCount) setSourceErrors((current) => ({ ...current, [src]: `${faI.format(edgeRecoveryCount)} دسته از قیمت‌های تاریخ‌دار از مسیر جایگزین بازیابی شد؛ صحت لحظه‌ای مستقل تأیید نشده است.` }));
      const dates = successful.map((result) => Number(result.data!.latestDate || 0)).filter(Boolean);
      const fetchedTimes = successful.map((result) => Date.parse(result.data!.fetchedAt || "")).filter(Number.isFinite);
      const rowDates = rows.map((row) => Number(row.priceQuote?.sessionDate ?? row.three?.currentDate ?? 0)).filter(Boolean);
      const resolvedLatestDate = rowDates.length ? Math.max(...rowDates) : dates.length ? Math.max(...dates) : null;
      const resolvedFetchedAt = fetchedTimes.length ? new Date(Math.max(...fetchedTimes)) : new Date();

      if (sourceRequests.current[src] !== requestId) return;

      if (src === "haghighi") setHaghighiRows(rows);
      else if (src === "zarbanana") setZarbananaRows(rows);
      else setCustomRows(rows);
      setSourceMeta((current) => ({ ...current, [src]: { latestDate: resolvedLatestDate, updatedAt: resolvedFetchedAt } }));
      const errors = rows.filter((row) => row.status === "error").length;
      const exp = expectedDate();
      const behind = Boolean(resolvedLatestDate && exp && resolvedLatestDate < exp);
      const freshness = summarizeScreenerFreshness(rows, exp);
      if (activeSourceRef.current === src) setNotice(behind
        ? `منبع داده هنوز جلسه جدیدتری منتشر نکرده یا بازار تعطیل بوده است؛ آخرین جلسه: ${fmtDate(resolvedLatestDate)}.`
        : errors ? `قیمت‌ها بروزرسانی شد؛ دریافت اطلاعات ${faI.format(errors)} نماد کامل نشد؛ دلیل هر نماد در وضعیت آن آمده است.`
        : freshness.earlierThanCalendar ? `قیمت پایانی ${faI.format(freshness.earlierThanCalendar)} نماد از آخرین جلسه مورد انتظار تقویمی قدیمی‌تر است؛ ممکن است نماد متوقف بوده یا منبع داده تأخیر داشته باشد.`
        : `اطلاعات ${faI.format(rows.length)} نماد آماده شد.`);
      // The deadline only bounds the visible wait. Remaining symbols continue
      // quietly, two at a time, and each confirmed row is published on its own;
      // a newer request aborts the shared controller and stops this pass.
      if (verificationBudgetExpired) {
        const pending = rows.filter((row) => row.quoteVerified !== true && row.insCode && row.analysisInput);
        if (pending.length) void browserQuotes.refresh(pending, () => sourceRequests.current[src] === requestId && !controller.signal.aborted, controller.signal, publishVerified, { concurrency: 2 }).catch(() => { /* cancelled passes keep each confirmed row */ });
      }
      void fetchHolderChangeSummaries(rows);
    } catch (err) {
      if (sourceRequests.current[src] !== requestId) return;
      setSourceErrors((current) => ({ ...current, [src]: err instanceof Error ? err.message : "دریافت ناموفق بود." }));
      const staleRows = markScreenerRowsStale(getSourceRows(src), "بروزرسانی تازه ناموفق بود؛ داده قبلی حفظ شد.");
      if (src === "haghighi") setHaghighiRows(staleRows);
      else if (src === "zarbanana") setZarbananaRows(staleRows);
      else setCustomRows(staleRows);
      if (activeSourceRef.current === src) setNotice(err instanceof Error ? `خطا: ${err.message}` : "دریافت قیمت‌ها ناموفق بود.");
    } finally {
      if (sourceRequests.current[src] === requestId) setSourceLoading((current) => ({ ...current, [src]: false }));
    }
  }

  async function fetchHolderChangeSummaries(rows: ScreenerRow[]) {
    const instruments = rows.flatMap((row) => row.insCode
      ? [{ symbol: row.symbol, insCode: row.insCode }]
      : []);
    if (!instruments.length) return;
    const requestId = ++holderChangeRequest.current;
    for (const { symbol } of instruments) holderSymbolRequests.current[symbol] = requestId;
    setPendingHolderChanges((count) => count + 1);
    try {
      await mapConcurrent(chunks(instruments, 250), 2, async (batch) => {
        let data: { summaries?: Record<string, HolderChangeSummary>; sourceDate?: number; fallback?: boolean; delivery?: HolderDelivery } = {};
        try {
          const response = await requestData(`holder-increases?_=${Date.now()}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ instruments: batch }),
          }, 15_000);
          if (response.ok) data = await readApiJson<typeof data>(response);
        } catch { /* Direct source below also covers malformed HTTP responses. */ }
        if (data.fallback || !data.summaries) {
          try {
            const direct = await browserMarket.summaries(batch);
            if (!data.sourceDate || direct.sourceDate >= data.sourceDate) data = direct;
          } catch { /* Keep the dated fallback, without inventing missing zeros. */ }
        }
        const summaries = data.summaries;
        const eligible = batch.filter(({ symbol }) => holderSymbolRequests.current[symbol] === requestId);
        if (summaries) {
          setHolderChangeSummaries((current) => {
            const next = { ...current };
            for (const { symbol } of eligible) {
              delete next[symbol];
              if (summaries[symbol]) next[symbol] = summaries[symbol];
            }
            return next;
          });
          setHolderChangeMeta((current) => ({ ...current, ...Object.fromEntries(eligible.map(({ symbol }) => [symbol, { date: data.sourceDate ?? null, fallback: Boolean(data.fallback), delivery: data.delivery }])) }));
        }
      });
    } catch {
      // Price/history remains usable when the independent shareholder source
      // is temporarily unavailable. The compact column stays unknown.
    } finally {
      setPendingHolderChanges((count) => count - 1);
    }
  }

  async function fetchMarketHighlights(src: WatchlistScope, symbols: string[]) {
    const requestId = ++highlightRequest.current;
    highlightController.current?.abort();
    const controller = new AbortController();
    highlightController.current = controller;
    const cacheKey = `${src}:${symbols.join(",")}`;
    const cached = highlightCache.current.get(cacheKey);
    setHighlightScope(src);
    setHighlightsError("");
    setHighlightSummary("");
    setHighlights(cached?.rows ?? []);
    setHighlightClientTypeUnavailable(Boolean(cached?.clientTypeUnavailable));
    setHighlightSessionDate(cached?.latestDate ?? null);
    setHighlightsUpdatedAt(cached?.fetchedAt ? new Date(cached.fetchedAt) : null);
    // Price ranking must finish before the 178-symbol shareholder lookup;
    // launching both at once exhausted upstream/Worker request budgets.
    const priorHoldings = increaseCache.current.get(cacheKey);
    setHighlightHoldings(priorHoldings ? { ...priorHoldings, delivery: priorHoldings.fallback ? "bundled" : "cache" } : null);
    setHighlightHoldingsError("");
    setHighlightHoldingsLoading(Boolean(symbols.length));
    if (!symbols.length) {
      setHighlights([]);
      setHighlightSessionDate(null);
      setHighlightClientTypeUnavailable(false);
      setHighlightsLoading(false);
      setHighlightHoldingsLoading(false);
      setNotice(`فهرست ${scopeLabel(src)} نمادی برای محاسبه ندارد.`);
      return;
    }
    setHighlightsLoading(true);
    setNotice(`در حال محاسبه رتبه‌بندی‌های ${faI.format(symbols.length)} نماد ${scopeLabel(src)}…`);
    try {
      const progressive = new Map<string, MarketHighlight>();
      const loaded = await loadBatches<HighlightSnapshot>(chunks(symbols, HIGHLIGHT_BATCH_SIZE), async (batch, signal): Promise<HighlightSnapshot> => {
        if (highlightRequest.current !== requestId) return { rows: [], partial: true, error: "محدوده اسکن تغییر کرد." };
        const recover = () => recoverHighlightPrices(batch, signal);
        // Zarvan's dated CORS feed is the lightweight primary for price/volume
        // rankings. Avoid issuing 18 expensive Worker requests that frequently
        // return edge HTTP 503 during a full-list refresh. The Worker remains
        // an independent fallback if this direct path is blocked or incomplete.
        let direct: HighlightSnapshot | null = null;
        try {
          direct = await recover();
          if (direct.rows.length === batch.length && direct.rows.every((row) =>
            row.sessionDate != null && row.sessionDate >= expectedHighlightSession(row.name))) return direct;
        } catch (error) {
          if (signal.aborted) throw error;
        }
        let response: Response;
        try {
          response = await requestData(`market-highlights?_=${Date.now()}`, {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: batch, pricesOnly: true }), signal,
          }, 10_000);
        } catch (error) {
          if (signal.aborted) throw error;
          if (direct?.rows.length) return direct;
          throw error;
        }
        if (response.status >= 500) {
          if (direct?.rows.length) return direct;
          throw new Error(`دسترسی مستقیم و Worker هر دو ناموفق بودند (HTTP ${response.status}).`);
        }
        let page: HighlightSnapshot;
        try { page = await readApiJson<HighlightSnapshot>(response); }
        catch { if (direct?.rows.length) return direct; throw new Error("پاسخ Worker معتبر نیست و مسیر مستقیم هم داده‌ای نداد."); }
        if (!response.ok) throw new Error(page.error || `رتبه‌بندی HTTP ${response.status} برگرداند.`);
        if (!Array.isArray(page.rows)) {
          if (direct?.rows.length) return direct;
          throw new Error("Worker داده قیمت معتبری برنگرداند.");
        }
        // Recover only the omitted/undated symbols, then retain the most recent
        // *source-dated* row. A failure of recovery cannot erase valid rows.
        const received = new Map(page.rows.filter((row) => sourceSession(row.sessionDate) && row.priceLast > 0 && row.priceClose > 0)
          .map((row) => [normalizeSymbol(row.symbol), row]));
        for (const row of direct?.rows ?? []) {
          const key = normalizeSymbol(row.symbol), previous = received.get(key);
          if (!previous || (row.sessionDate ?? 0) > (previous.sessionDate ?? 0)) received.set(key, row);
        }
        const missing = batch.filter((symbol) => {
          const row = received.get(normalizeSymbol(symbol));
          return !row || (row.sessionDate ?? 0) < expectedHighlightSession(row.name);
        });
        if (missing.length) {
          try {
            const extra = await recoverHighlightPrices(missing, signal);
            for (const row of extra.rows) {
              const key = normalizeSymbol(row.symbol), before = received.get(key);
              if (!before || (row.sessionDate ?? 0) > (before.sessionDate ?? 0)) received.set(key, row);
            }
          } catch { /* Do not lose verified rows from the first response. */ }
        }
        if (!received.size) throw new Error(page.error || "قیمت تاریخ‌دار معتبر دریافت نشد.");
        const rows = batch.flatMap((symbol) => received.get(normalizeSymbol(symbol)) ? [received.get(normalizeSymbol(symbol))!] : []);
        return { ...page, rows, missingCount: batch.length - rows.length, partial: Boolean(page.partial) || rows.length !== batch.length };
      }, { signal: controller.signal, budgetMs: 240_000, attemptMs: 30_000, retryMs: 1_200, concurrency: 2, pauseMs: 180, onSuccess: (batch, page) => {
        if (highlightRequest.current !== requestId || controller.signal.aborted) return;
        for (const row of page.rows) if (batch.includes(row.symbol)) progressive.set(row.symbol, row);
        const shown = preserveHighlightRows(cached?.rows ?? [], [...progressive.values()], symbols).rows;
        setHighlights(shown);
        setHighlightClientTypeUnavailable(shown.some(row => !row.clientTypeAvailable));
        setHighlightSessionDate(Math.max(0, ...shown.map(row => row.sessionDate ?? 0)) || null);
      } });
      const pages = loaded.results.flatMap((result) => result.data ? [result.data] : [{ rows: [], error: result.error ?? "دریافت ناموفق", partial: true }]);
      if (!pages.length || pages.every((page) => page.error)) throw new Error(pages[0]?.error || "مهلت دریافت رتبه‌بندی‌ها تمام شد.");
      const data: HighlightSnapshot = {
        rows: pages.flatMap((page) => page.rows), fetchedAt: new Date().toISOString(),
        latestDate: Math.max(...pages.map((page) => page.latestDate ?? 0)) || null,
        partial: loaded.expired || pages.some((page) => page.partial), clientTypeUnavailable: pages.some((page) => page.clientTypeUnavailable),
        missingCount: Math.max(0, symbols.length - new Set(pages.flatMap((page) => page.rows.map((row) => normalizeSymbol(row.symbol)))).size),
      };
      // Preserve validated details already obtained for the same trading session.
      // A price-only refresh must never downgrade official ClientType/floor evidence.
      const cachedBySymbol = new Map((cached?.rows ?? []).map(row => [row.symbol, row]));
      let resolvedRows = data.rows.map((row) => {
        const old = cachedBySymbol.get(row.symbol);
        if (!old || old.sessionDate !== row.sessionDate) return row;
        return { ...row,
          ...(old.clientTypeAvailable && old.clientTypeDate === row.sessionDate ? {
            realBuyValue: old.realBuyValue, realSellValue: old.realSellValue, netRealValue: old.netRealValue,
            clientTypeDate: old.clientTypeDate, clientTypeAvailable: old.clientTypeAvailable,
            clientTypeFetchedAt: old.clientTypeFetchedAt, realBuyVolume: old.realBuyVolume,
            realSellVolume: old.realSellVolume, buyPower: old.buyPower,
          } : {}),
          ...(old.floorVerified && old.floorDate === row.sessionDate ? {
            allowedMin: old.allowedMin, floorVerified: true, floorDate: old.floorDate,
            floorFetchedAt: old.floorFetchedAt,
            touchedSellQueue: Math.abs(row.priceMin - old.allowedMin) < 0.5,
          } : {}),
        };
      });
      let clientTypeUnavailable = Boolean(data.clientTypeUnavailable);
      const keepDetails = (partial: MarketHighlight[]) => {
        if (highlightRequest.current !== requestId || controller.signal.aborted) return;
        resolvedRows = partial; setHighlights(partial);
        setHighlightClientTypeUnavailable(partial.some(row => !row.clientTypeAvailable));
      };
      try { resolvedRows = await withDeadline((signal) => browserQuotes.details(resolvedRows, () => highlightRequest.current === requestId && !signal.aborted, signal, keepDetails), 25_000, controller.signal); } catch { /* Keep base prices and each independently completed detail. */ }
      if (highlightRequest.current !== requestId) return;
      const preserved = preserveHighlightRows(cached?.rows ?? [], resolvedRows, symbols);
      resolvedRows = preserved.rows;
      if (preserved.retained) data.partial = true;
      clientTypeUnavailable = resolvedRows.some((row) => !row.clientTypeAvailable);
      const verifiedDates = resolvedRows.map((row) => row.sessionDate ?? 0).filter(Boolean);
      data.latestDate = verifiedDates.length ? Math.max(...verifiedDates) : data.latestDate;
      highlightCache.current.set(cacheKey, { ...data, rows: resolvedRows, clientTypeUnavailable });
      setHighlights(resolvedRows);
      setHighlightsUpdatedAt(data.fetchedAt ? new Date(data.fetchedAt) : new Date());
      setHighlightSessionDate(data.latestDate ?? null);
      setHighlightClientTypeUnavailable(clientTypeUnavailable);
      // Price/volume/value coverage is reported independently of missing
      // official ClientType/floor in the panel's coverage calculation.
      const missingMessage = data.partial && data.missingCount
        ? `؛ دریافت ${faI.format(data.missingCount)} نماد کامل نشد؛ علت می‌تواند خطای درخواست یا پایان مهلت باشد`
        : "";
      const refreshedCount = new Set(data.rows.map((row) => normalizeSymbol(row.symbol))).size;
      const summary = `رتبه‌بندی برای ${faI.format(refreshedCount)} نماد فهرست ${scopeLabel(src)} تازه دریافت شد${preserved.retained ? `؛ ${faI.format(preserved.retained)} نماد با داده قبلی حفظ شد` : ""}${missingMessage}.`;
      setHighlightSummary(summary);
      setNotice(summary);
    } catch (error) {
      if (highlightRequest.current !== requestId) return;
      setHighlightsError(error instanceof Error ? error.message : "دریافت ناموفق");
      setNotice(error instanceof Error ? `خطا: ${error.message}` : "فیلترهای معاملاتی دریافت نشد.");
    } finally {
      if (highlightRequest.current === requestId) {
        setHighlightsLoading(false);
        if (!controller.signal.aborted) void fetchHighlightHoldings(requestId, cacheKey, symbols, controller.signal);
      }
    }
  }

  async function fetchHighlightHoldings(requestId: number, cacheKey: string, symbols: string[], signal: AbortSignal) {
    const cachedHoldings = increaseCache.current.get(cacheKey);
    setHighlightHoldings(cachedHoldings ? { ...cachedHoldings, delivery: cachedHoldings.fallback ? "bundled" : "cache" } : null);
    setHighlightHoldingsError("");
    setHighlightHoldingsLoading(Boolean(symbols.length));
    if (!symbols.length) return;
    try {
      const data = await fetchHoldingRows(symbols, () => highlightRequest.current === requestId, signal);
      if (highlightRequest.current !== requestId) return;
      const safe = preserveDatedHolderRefresh(cachedHoldings, data);
      increaseCache.current.set(cacheKey, safe);
      setHighlightHoldings(safe);
    } catch (error) {
      if (highlightRequest.current === requestId) setHighlightHoldingsError(error instanceof Error ? error.message : "دریافت تغییرات سهامداران ناموفق بود.");
    } finally {
      if (highlightRequest.current === requestId) setHighlightHoldingsLoading(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HOLDER SCANNING
  // ══════════════════════════════════════════════════════════════════════════
  async function scanHolders(list: string[], force: boolean, scope: string) {
    const token = holderScanToken.current + 1;
    holderScanToken.current = token;
    const rawMeta = (() => { try { const raw = window.localStorage.getItem(K_HOLDERS_CACHE); if (!raw) return null; const obj = JSON.parse(raw) as { updatedAt?: number; meta?: Record<string, HolderRecord> }; return obj?.meta ?? null; } catch { return null; } })();
    const normalizedPrior: Record<string, HolderRecord> = (() => {
      const prior: unknown = rawMeta ?? holderMetaRef.current;
      if (!prior || typeof prior !== "object" || Array.isArray(prior)) return {};
      if (prior instanceof Map) return Object.fromEntries((prior as Map<string, HolderRecord>).entries());
      // Backward compat: legacy v1 stored a bare number/null map.
      if ("counts" in prior && typeof (prior as Record<string, unknown>).counts === "object") {
        const counts = (prior as { counts?: Record<string, number | null> }).counts ?? {};
        return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, typeof v === "number" ? { count: v, status: v === 0 ? "verified-zero" : "verified", sourceDate: null, retrievedAt: null, delivery: "cache" as const, partial: true } : { count: null, status: "unavailable" as const, sourceDate: null, retrievedAt: null, delivery: "cache" as const, partial: true }]));
      }
      const obj = prior as Record<string, unknown>;
      if (Object.values(obj).every((v) => typeof v === "number" || v === null)) {
        return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, typeof v === "number" ? { count: v, status: v === 0 ? "verified-zero" : "verified", sourceDate: null, retrievedAt: null, delivery: "cache" as const, partial: true } : { count: null, status: "unavailable" as const, sourceDate: null, retrievedAt: null, delivery: "cache" as const, partial: true }]));
      }
      const meta = obj as Record<string, HolderRecord>;
      return Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v as HolderRecord]));
    })();

    const unique = Array.from(new Set(list));
    const session = expectedDate();
    const targets = pendingHolderSymbols(unique, normalizedPrior, { force, now: Date.now(), expectedSession: session, maxAgeMs: HOLDER_CACHE_AGE });
    const meta = { ...normalizedPrior } as Record<string, HolderRecord>;
    const publish = () => {
      holderMetaRef.current = { ...meta };
      setHolderMeta(holderMetaRef.current);
      const counts: Record<string, number | null> = {};
      for (const [s, r] of Object.entries(meta)) counts[s] = r.count;
      holderCountsRef.current = counts;
      setHolderCounts(counts);
      try { window.localStorage.setItem(K_HOLDERS_CACHE, JSON.stringify({ updatedAt: Date.now(), meta })); } catch { /* Storage may be disabled. */ }
    };
    if (!targets.length) {
      manualController.current?.abort();
      publish();
      setHolderScanning(false); setHolderScope("");
      setNotice(`تعداد حقیقی‌های عمده از حافظه محلی خوانده شد؛ اسکن جدید انجام نشد و تاریخ جلسه واقعی این منبع قابل تأیید نیست.`);
      return;
    }

    holderCacheFresh.current = false;
    setHolderScanning(true); setHolderScope(scope);
    setHolderProgress({ done: 0, total: targets.length });
    manualController.current?.abort();
    const controller = new AbortController();
    manualController.current = controller;
    const batches = chunks(targets, HOLDER_BATCH_SIZE);
    let processed = 0, failedBatches = 0;
    try {
      await withDeadline(async (signal) => {
        for (let i = 0; i < batches.length; i++) {
          signal.throwIfAborted();
          if (holderScanToken.current !== token) return;
          // Keep a verified observation visible while its replacement is in flight.
          for (const s of batches[i]) if (!meta[s] || holderStatus(meta[s].count) !== meta[s].status) {
            meta[s] = { count: null, status: "processing", sourceDate: null, retrievedAt: null, delivery: "source", partial: false };
          }
          publish();
          try {
            const res = await requestData("holders", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: batches[i] }), signal }, 20_000);
            const data = await readApiJson<{ counts?: Record<string, number | null>; outcomes?: Record<string, { count: number | null; status: HolderRecord["status"]; sourceDate: number | null }>; partial?: boolean }>(res);
            if (!res.ok || !data.counts) throw new Error("پاسخ شمارش معتبر نیست.");
            if (holderScanToken.current !== token || signal.aborted) return;
            const now = Date.now();
            let receivedVerified = 0;
            for (const s of batches[i]) {
              const value = data.counts?.[s];
              const status = holderStatus(value);
              const outcome = data.outcomes?.[s];
              const outcomeStatus = outcome?.status;
              const safeStatus = status !== "unavailable" && (!outcomeStatus || outcomeStatus === status)
                ? status : outcomeStatus === "timeout" || outcomeStatus === "failed" || outcomeStatus === "invalid-source" ? outcomeStatus : "unavailable";
              if (safeStatus === "verified" || safeStatus === "verified-zero") {
                receivedVerified++;
                meta[s] = { count: value as number, status: safeStatus, sourceDate: outcome?.sourceDate ?? null, retrievedAt: now, checkedSession: session, delivery: "source", partial: Boolean(data.partial) };
              } else {
                meta[s] = retainHolderOnFailure(meta[s], safeStatus === "unavailable" ? "unavailable" : safeStatus, now, session);
              }
            }
            // A structurally valid batch with ten unknown counts is still an
            // upstream failure: stop after repeated unusable batches.
            failedBatches = receivedVerified > 0 ? 0 : failedBatches + 1;
          } catch (error) {
            if (signal.aborted) throw error;
            const now = Date.now();
            for (const s of batches[i]) {
              meta[s] = retainHolderOnFailure(meta[s], holderErrorStatus(error), now, session);
            }
            failedBatches++;
          }
          if (holderScanToken.current !== token) return;
          processed += batches[i].length;
          publish();
          setHolderProgress({ done: processed, total: targets.length });
          const retained = unique.filter((s) => meta[s]?.delivery === "cache" && meta[s]?.lastRefreshFailure).length;
          setNotice(`اسکن حقیقی‌های عمده ${scope}: ${faI.format(processed)} از ${faI.format(targets.length)}${retained ? `؛ ${faI.format(retained)} شمارش قبلی با برچسب ذخیره‌شده/قدیمی حفظ شده و دریافت جدید آن ناموفق بود` : ""}`);
          if (failedBatches >= 3) throw new Error("منبع سهامداران پاسخ نمی‌دهد؛ اسکن ناقص متوقف شد. داده‌های قبلی حفظ شدند.");
          if (i < batches.length - 1) await withDeadline(() => wait(HOLDER_BATCH_PAUSE), HOLDER_BATCH_PAUSE + 100, signal);
        }
      }, 600_000, controller.signal);
      if (holderScanToken.current === token) {
        const verified = unique.filter((s) => (meta[s]?.status === "verified" || meta[s]?.status === "verified-zero") && !meta[s]?.lastRefreshFailure);
        const retained = unique.filter((s) => meta[s]?.delivery === "cache" && meta[s]?.lastRefreshFailure);
        const unavailable = unique.filter((s) => meta[s]?.status === "unavailable" || meta[s]?.status === "timeout" || meta[s]?.status === "failed" || meta[s]?.status === "invalid-source");
        if (unavailable.length || retained.length) setNotice(`اسکن حقیقی‌های عمده ${scope} ناقص ماند؛ ${faI.format(verified.length)} نتیجه تأییدشده، ${faI.format(retained.length)} شمارش قدیمی ذخیره‌شده (دریافت جدید ناموفق)، ${faI.format(unavailable.length)} نماد بدون شمارش معتبر. شمارش‌های ذخیره‌شده قابل تلاش مجدد هستند.`);
        else setNotice(`اسکن حقیقی‌های عمده ${scope} کامل شد.`);
      }
    } catch (error) {
      if (holderScanToken.current === token) {
        const retained = unique.filter((s) => meta[s]?.delivery === "cache" && meta[s]?.lastRefreshFailure).length;
        setNotice(`${error instanceof Error ? error.message : "اسکن ناموفق بود."}${retained ? ` ${faI.format(retained)} شمارش قبلی ذخیره‌شده و احتمالاً قدیمی حفظ شد؛ بروزرسانی آن‌ها دوباره تلاش می‌شود.` : ""}`);
      }
    } finally {
      if (holderScanToken.current === token) {
        setHolderScanning(false); setHolderScope("");
        holderCacheFresh.current = pendingHolderSymbols(unique, meta, { now: Date.now(), expectedSession: session, maxAgeMs: HOLDER_CACHE_AGE }).length === 0;
        publish();
      }
    }
  }

  function stopHolderScan() {
    holderScanToken.current += 1;
    manualController.current?.abort();
    const meta = releaseProcessingHolders(holderMetaRef.current);
    holderMetaRef.current = meta;
    setHolderMeta(meta);
    try { window.localStorage.setItem(K_HOLDERS_CACHE, JSON.stringify({ updatedAt: Date.now(), meta })); } catch { /* Storage may be disabled. */ }
    setHolderScanning(false); setHolderScope("");
    setNotice("اسکن متوقف شد.");
  }

  async function startMarketScan() {
    if (holderScanning && holderScope === "کل بازار") { stopHolderScan(); return; }
    let uni = marketUniverse;
    // A partial universe can gain symbols on the next attempt. Reconcile by
    // symbol identity so a failed/incomplete retry never loses known rows.
    if (!uni.length || marketUniversePartial) {
      setMarketLoading(true);
      setNotice(uni.length ? "در حال تلاش مجدد برای تکمیل فهرست بازار…" : "در حال ساخت فهرست نمادهای فعال…");
      try {
        const res = await requestData("market-universe", {}, 45_000);
        const data = await readApiJson<{ symbols?: MarketSymbol[]; error?: string; partial?: boolean; incompleteSources?: string[] }>(res);
        if (!res.ok || !Array.isArray(data.symbols)) throw new Error(data.error || "پاسخ نامعتبر");
        const accepted = acceptMarketUniverse(data);
        if (!accepted.symbols.length) throw new Error(data.error || "فهرست کل بازار خالی است.");
        const merged = mergeMarketUniverse(uni, accepted.symbols);
        uni = merged.symbols;
        const incomplete = accepted.partial || merged.retained > 0;
        setMarketUniverse(uni);
        setMarketUniversePartial(incomplete);
        if (incomplete) {
          const missing = uni.length >= 600 ? `؛ ${faI.format(uni.length)} نماد معتبر دریافت شد اما فهرست بازار کاملاً تکمیل نشده است` : `؛ فهرست بازار ناقص است (${faI.format(uni.length)} نماد)؛ اسکن با داده‌های موجود ادامه می‌یابد`;
          setNotice(`${faI.format(uni.length)} نماد معتبر برای اسکن حفظ شد${merged.retained ? `؛ ${faI.format(merged.retained)} نماد قبلی در پاسخ جدید نبود و حذف نشد` : ""}${missing}.`);
        } else {
          setNotice(`${faI.format(uni.length)} نماد پیدا شد؛ اسکن شروع می‌شود.`);
        }
      } catch (err) {
        setMarketUniversePartial(true);
        setNotice(`${err instanceof Error ? `خطا در تکمیل فهرست: ${err.message}` : "فهرست کل بازار دریافت نشد."}${uni.length ? `؛ ${faI.format(uni.length)} نماد شناخته‌شده حفظ شدند و اسکن آن‌ها ادامه دارد.` : ""}`);
        if (!uni.length) { setMarketLoading(false); return; }
      }
      setMarketLoading(false);
    }
    await scanHolders(uni.map((i) => i.symbol), false, "کل بازار");
  }

  async function fetchHolderIncreases(scope: HolderScope = increaseScope) {
    const requestId = ++increaseRequest.current;
    increaseController.current?.abort();
    const controller = new AbortController();
    increaseController.current = controller;
    const symbols = scope === "market" ? undefined : getScopeSymbols(scope);
    const key = `${scope}:${symbols?.join(",") ?? ""}`;
    const cached = increaseCache.current.get(key);
    setIncreaseScope(scope);
    setIncreaseError("");
    setIncreaseScanned(Boolean(cached));
    setHolderIncreaseRows(cached?.rows ?? []);
    setHolderIncreaseDate(cached?.sourceDate ?? null);
    setHolderIncreaseUpdatedAt(cached?.fetchedAt ? new Date(cached.fetchedAt) : null);
    setHolderIncreasePartial(Boolean(cached?.partial));
    setHolderIncreaseFallback(Boolean(cached?.fallback));
    setHolderIncreaseDelivery(cached ? cached.fallback ? "bundled" : "cache" : undefined);
    if (symbols && !symbols.length) { setHolderIncreaseLoading(false); setNotice("این واچ‌لیست خالی است."); return; }
    setHolderIncreaseLoading(true);
    setNotice(`در حال دریافت تغییرات سهامداران عمده حقیقی ${scopeLabel(scope)}…`);
    try {
      const data = await fetchHoldingRows(symbols, () => increaseRequest.current === requestId, controller.signal);
      if (increaseRequest.current !== requestId) return;
      increaseCache.current.set(key, data);
      setIncreaseScanned(true);
      setHolderIncreaseRows(data.rows);
      setHolderIncreaseDate(data.sourceDate ?? null);
      setHolderIncreaseUpdatedAt(data.fetchedAt ? new Date(data.fetchedAt) : new Date());
      setHolderIncreasePartial(Boolean(data.partial));
      setHolderIncreaseFallback(Boolean(data.fallback));
      setHolderIncreaseDelivery(data.delivery);
      setNotice(data.fallback
        ? `${faI.format(data.rows.length)} رکورد از نسخه پشتیبان تاریخی (${data.sourceDate ? fmtDate(data.sourceDate) : "بدون تاریخ"}) خوانده شد؛ داده زنده تأیید نشد.`
        : `${faI.format(data.rows.length)} افزایش سهامدار عمده حقیقی از ${scopeLabel(scope)} دریافت شد.`);
    } catch (error) {
      if (increaseRequest.current !== requestId) return;
      setIncreaseError(error instanceof Error ? error.message : "دریافت تغییرات ناموفق بود.");
      setNotice(error instanceof Error ? `خطا: ${error.message}` : "تغییرات سهامداران عمده دریافت نشد.");
    } finally {
      if (increaseRequest.current === requestId) setHolderIncreaseLoading(false);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // FAVORITES
  // ══════════════════════════════════════════════════════════════════════════
  function toggleFav(symbol: string) {
    const next = new Set(sharedFavs);
    const n = normalizeSymbol(symbol);
    if (next.has(n)) next.delete(n); else next.add(n);
    setSharedFavs(next);
    persistPreference(K_FAVS, JSON.stringify(Array.from(next)));
  }

  async function loadMissingFavorites() {
    const known = new Set([...haghighiRows, ...zarbananaRows, ...customRows, ...favoriteFetchedRows].map((row) => normalizeSymbol(row.symbol)));
    const missing = [...sharedFavs].filter((symbol) => !known.has(normalizeSymbol(symbol)));
    if (!missing.length || favoriteLoading) return;
    setFavoriteLoading(true);
    setFavoriteError("");
    const resolved = new Map<string, ScreenerRow>();
    try {
      for (const batch of chunks(missing, SCREENER_BATCH_SIZE)) {
        try {
          const response = await requestData("screener", {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: batch, baseOnly: true }),
          }, 15_000);
          const data = response.ok ? await readApiJson<ScreenerApiPayload>(response) : null;
          if (!Array.isArray(data?.rows)) throw new Error("پاسخ قیمت منتخب‌ها معتبر نیست.");
          for (const row of data.rows) if (row.three || row.six) resolved.set(normalizeSymbol(row.symbol), row);
        } catch {
          try {
            const recovered = await recoverDatedScreenerBatch(batch, new AbortController().signal);
            for (const row of recovered.rows) if (row.three || row.six) resolved.set(normalizeSymbol(row.symbol), row);
          } catch { /* Preserve the symbol even if its data source is unavailable. */ }
        }
      }
      if (resolved.size) setFavoriteFetchedRows((prev) => {
        const merged = new Map(prev.map((row) => [normalizeSymbol(row.symbol), row]));
        for (const [symbol, row] of resolved) merged.set(symbol, row);
        return [...merged.values()];
      });
      if (resolved.size < missing.length) setFavoriteError(`قیمت ${faI.format(missing.length - resolved.size)} نماد منتخب دریافت نشد؛ نام نمادها همچنان حفظ شده است.`);
    } finally { setFavoriteLoading(false); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // MODAL MANAGEMENT
  // ══════════════════════════════════════════════════════════════════════════
  function openMgr(src: SourceKey) {
    setActiveSource(src);
    persistPreference(K_ACTIVE_SOURCE, src);
    setMgrOpen(src);
    if (src === "haghighi") setMgrDraft(haghighiDraft);
    else if (src === "zarbanana") setMgrDraft(zarbananaDraft);
    else setMgrDraft(customDraft);
  }

  function saveMgr() {
    if (!mgrOpen) return;
    const parsed = parseTxtSymbols(mgrDraft);
    if (!parsed.length) { setNotice("حداقل یک نماد معتبر فارسی وارد کن."); return; }
    let saved = false;
    if (mgrOpen === "haghighi") {
      setHaghighiSymbols(parsed); setHaghighiDraft(parsed.join("\n"));
      saved = persistPreference(K_HAGHIGHI, JSON.stringify(parsed));
      void fetchSourceData("haghighi", parsed);
    } else if (mgrOpen === "zarbanana") {
      setZarbananaSymbols(parsed); setZarbananaDraft(parsed.join("\n"));
      saved = persistPreference(K_ZARBANANA, JSON.stringify(parsed));
      void fetchSourceData("zarbanana", parsed);
    } else {
      setCustomSymbols(parsed); setCustomDraft(parsed.join("\n"));
      saved = persistPreference(K_CUSTOM, JSON.stringify(parsed));
      void fetchSourceData("custom", parsed);
    }
    setMgrOpen(null);
    setNotice(saved ? `${faI.format(parsed.length)} نماد ذخیره شد.` : `${faI.format(parsed.length)} نماد فقط در این نشست تغییر کرد؛ مرورگر اجازه ذخیره پایدار نمی‌دهد.`);
  }

  async function handleMgrFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; if (!file) return;
    const buf = await file.arrayBuffer();
    let text = "";
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); }
    catch { text = new TextDecoder("windows-1256").decode(buf); }
    setMgrDraft(parseTxtSymbols(text).join("\n"));
    setNotice(`${faI.format(parseTxtSymbols(text).length)} نماد از فایل خوانده شد.`);
    event.target.value = "";
  }

  function exportMgrTxt() {
    if (!mgrOpen) return;
    const syms = mgrOpen === "haghighi" ? haghighiSymbols : mgrOpen === "zarbanana" ? zarbananaSymbols : customSymbols;
    const blob = new Blob([syms.join("\r\n")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url;
    a.download = mgrOpen === "haghighi" ? "نمادهای-حقیقی.txt" : mgrOpen === "zarbanana" ? "نمادهای-زردنارنجی.txt" : "نمادهای-دلخواه.txt";
    a.click(); URL.revokeObjectURL(url);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // SORTING
  // ══════════════════════════════════════════════════════════════════════════
  function doSort(column: string) {
    if (sortCol === column) setSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setSortCol(column); setSortDir(column === "symbol" ? "asc" : "desc"); }
  }

  function sortHolders(column: string) {
    if (holderSortCol === column) setHolderSortDir((d) => d === "asc" ? "desc" : "asc");
    else { setHolderSortCol(column); setHolderSortDir(column === "realHolders" ? "desc" : "asc"); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // COMPUTED DATA
  // ══════════════════════════════════════════════════════════════════════════
  const period: Period = activeTab === "6m" ? "6m" : "3m";

  // Current source rows (for 3m/6m tabs)
  const currentRows = useMemo(() => getSourceRows(activeSource), [activeSource, getSourceRows]);
  const activeRowsSession = useMemo(() => screenerRowsSession(currentRows), [currentRows]);
  // Every row is either confirmed for the expected session or settled by the
  // source itself, so nothing is left that a network call could improve today.
  const allRowsConfirmed = currentRows.length > 0 && !loading && !screenerPendingVerification(currentRows, expectedSession).length;
  const nextSessionWeekday = new Intl.DateTimeFormat("fa-IR", { weekday: "long", timeZone: "Asia/Tehran" }).format(nextScreenerRefreshAt(new Date()));

  const enrichedRows = useMemo(() => currentRows.map((row) => ({
    ...row,
    ...(displayMode === "peakDrop" && row.peakDrops ? (period === "3m" ? { three: row.peakDrops[peakDropPeriod] } : { six: row.peakDrops[peakDropPeriod] }) : {}),
    realHolders: typeof holderCounts[row.symbol] === "number" ? holderCounts[row.symbol] : null,
    holderChange: holderChangeSummaries[normalizeSymbol(row.symbol)],
  })), [currentRows, holderCounts, displayMode, period, peakDropPeriod, holderChangeSummaries]);

  // Apply display mode filters
  const filteredRows = useMemo(() => {
    let next = enrichedRows;
    if (displayMode === "peakDrop") next = next.filter((r) => (gm(r, period)?.drawdownPct ?? 0) > 0);
    if (displayMode === "rsiOversold") next = next.filter((r) => r.rsi !== null && r.rsi <= 30);
    if (displayMode === "combined") next = next.filter((r) => r.rsi !== null && r.rsi <= 30 && (gm(r, period)?.drawdownPct ?? 0) > 0);
    if (displayMode === "selectedOnly") next = next.filter((r) => sharedFavs.has(normalizeSymbol(r.symbol)));
    if (displayMode === "bullDiv") next = next.filter((r) => r.divergence?.kind === "positive");
    if (displayMode === "bearDiv") next = next.filter((r) => r.divergence?.kind === "negative");
    if (displayMode === "epsSectorPe") next = next.filter((r) => r.valuation?.epsSectorPePositive);
    if (displayMode === "peBelowSector") next = next.filter((r) => r.valuation?.peBelowSector);
    if (displayMode === "holderBuys") next = next.filter((r) => (r.holderChange?.buyCount ?? 0) > 0);
    if (displayMode === "holderSells") next = next.filter((r) => (r.holderChange?.sellCount ?? 0) > 0);
    const q = normalizeSymbol(searchDraft).toLocaleLowerCase("fa");
    if (q) next = next.filter((r) => normalizeSymbol(`${r.symbol} ${r.name ?? ""}`).toLocaleLowerCase("fa").includes(q));
    return [...next].sort((a, b) => cmpRows(a, b, sortCol, sortDir, period));
  }, [displayMode, enrichedRows, period, sortCol, sortDir, searchDraft, sharedFavs]);

  // Summary stats
  const periodMetrics = enrichedRows.map((r) => gm(r, period)).filter((m): m is PeriodMetrics => Boolean(m));
  const posCount = periodMetrics.filter((m) => m.returnPct > 0).length;
  const negCount = periodMetrics.filter((m) => m.returnPct < 0).length;
  const oversoldCount = enrichedRows.filter((r) => r.rsi !== null && r.rsi <= 30).length;
  const bullishDivCount = enrichedRows.filter((r) => r.divergence?.kind === "positive").length;
  const bearishDivCount = enrichedRows.filter((r) => r.divergence?.kind === "negative").length;
  const epsSectorPeCount = enrichedRows.filter((r) => r.valuation?.epsSectorPePositive).length;
  const peBelowSectorCount = enrichedRows.filter((r) => r.valuation?.peBelowSector).length;
  const biggestDD = periodMetrics.length ? Math.max(...periodMetrics.map((m) => m.drawdownPct)) : null;
  const readyHolder = currentRows.filter((r) => typeof holderCounts[r.symbol] === "number").length;

  // Selected/favorites from all sources
  const allFavRows = useMemo(() => {
    const result: ScreenerRow[] = [];
    const seen = new Set<string>();
    const addRows = (rows: ScreenerRow[], source: string) => {
      for (const r of rows) {
        const n = normalizeSymbol(r.symbol);
        if (sharedFavs.has(n) && !seen.has(n)) {
          seen.add(n);
          result.push({ ...r, note: `${source}: ${r.name || r.symbol}` });
        }
      }
    };
    addRows(haghighiRows, "حقیقی");
    addRows(customRows, "دلخواه");
    addRows(zarbananaRows, "زرد/نارنجی");
    addRows(favoriteFetchedRows, "منتخبِ ذخیره‌شده");
    for (const symbol of sharedFavs) if (!seen.has(normalizeSymbol(symbol))) {
      result.push({ symbol, realHolders: null, rsi: null, three: null, six: null, actions: [], status: "error", note: "قیمت این نماد منتخب هنوز دریافت نشده است." });
    }
    return result;
  }, [haghighiRows, customRows, zarbananaRows, favoriteFetchedRows, sharedFavs]);

  // Holders tab sorted
  const sortedHolderRows = useMemo(() => {
    const q = normalizeSymbol(marketSearch).toLocaleLowerCase("fa");
    return marketUniverse
      .filter((i) => !q || normalizeSymbol(`${i.symbol} ${i.name}`).toLocaleLowerCase("fa").includes(q))
      .map((i) => ({
        symbol: i.symbol, name: i.name, rsi: null, insCode: undefined as string | undefined,
        realHolders: holderMeta[i.symbol]?.retrievedAt && (holderMeta[i.symbol].status === "verified" || holderMeta[i.symbol].status === "verified-zero") && typeof holderCounts[i.symbol] === "number" ? holderCounts[i.symbol] : null,
        three: null, six: null, actions: [], status: "ready" as const, note: undefined as string | undefined,
      }))
      .sort((a, b) => cmpRows(a, b, holderSortCol, holderSortDir, period));
  }, [holderCounts, holderMeta, holderSortCol, holderSortDir, marketSearch, marketUniverse, period]);

  const holderRanks = useMemo(() => Object.fromEntries(
    marketUniverse
      .filter((i) => holderMeta[i.symbol]?.retrievedAt && (holderMeta[i.symbol].status === "verified" || holderMeta[i.symbol].status === "verified-zero") && typeof holderCounts[i.symbol] === "number")
      .sort((a, b) => Number(holderCounts[b.symbol]) - Number(holderCounts[a.symbol]) || a.symbol.localeCompare(b.symbol, "fa"))
      .map((i, idx) => [i.symbol, idx + 1]),
  ), [holderCounts, holderMeta, marketUniverse]);

  const filteredHolderIncreases = useMemo(() => {
    const query = normalizeSymbol(holderIncreaseSearch).toLocaleLowerCase("fa");
    return holderIncreaseRows
      .filter((row) => !query || normalizeSymbol(
        `${row.symbol} ${row.instrumentName} ${row.market} ${row.shareholderType}`,
      ).toLocaleLowerCase("fa").includes(query))
      .map((row) => ({
        ...row,
        currentCompact: compactShares(row.currentShares),
        previousCompact: row.previousShares === null ? "ناموجود" : compactShares(row.previousShares),
        // English ASCII rendering for the client-requested numeric area.
        changeCompact: compactSharesEn(Math.abs(row.changeShares)),
        signedChangeEn: signedSharesEn(row.changeShares),
        // The API's ownershipPct is already a percentage — display as-is.
        ownershipCompact: row.ownershipPct === null ? null : faN.format(row.ownershipPct),
      }));
  }, [holderIncreaseRows, holderIncreaseSearch]);

  const holderIncreaseGroups = useMemo(
    () => groupHolderRowsBySymbol(filteredHolderIncreases),
    [filteredHolderIncreases],
  );

  const toggleHolderGroup = (symbol: string) => {
    setHolderIncreasesOpen((prev) => toggleSymbolInSet(prev, symbol));
  };

  const toggleHighlightGroup = (symbol: string) => {
    setHighlightOpenGroups((prev) => toggleSymbolInSet(prev, symbol));
  };

  const highlightGroups = useMemo(() => {
    // A few commodity funds can trade on Thursday while ordinary shares are
    // closed. Rank the dominant dated session, never silently mix sessions.
    const latest = primaryHighlightSession(highlights);
    const sessionRows = highlights.filter(row => latest > 0 && row.sessionDate === latest);
    const top = (rows: MarketHighlight[], metric: (row: MarketHighlight) => number) =>
      [...rows].filter((row) => metric(row) > 0).sort((a, b) => metric(b) - metric(a)).slice(0, 10);
    const values: HighlightListRow[] = top(sessionRows.filter(row => row.valueAvailable), (row) => row.value).map((row) => ({
      ...row, primary: `${faCompact.format(row.value)} ریال`, secondary: `آخرین ${fp(row.priceLast)} ریال`,
    }));
    const volumes: HighlightListRow[] = top(sessionRows.filter(row => row.volumeAvailable), (row) => row.volume).map((row) => ({
      ...row, primary: `${faCompact.format(row.volume)} سهم`, secondary: `ارزش ${faCompact.format(row.value)} ریال`,
    }));
    const realMoney: HighlightListRow[] = top(sessionRows.filter(row => row.clientTypeAvailable && row.clientTypeDate === latest && row.realBuyValue != null && row.realSellValue != null), (row) => row.realBuyValue! - row.realSellValue!).map((row) => ({
      ...row, primary: `${faCompact.format(row.realBuyValue! - row.realSellValue!)} ریال`, secondary: `قدرت خالص پول حقیقی`,
    }));
    const reversals = [...sessionRows]
      .filter(isSellQueueToPositive)
      .sort((a, b) => (closingPriceGap(b.priceLast, b.priceClose)?.percent ?? 0) - (closingPriceGap(a.priceLast, a.priceClose)?.percent ?? 0))
      .slice(0, 10);
    return { values, volumes, realMoney, reversals, sessionDate: latest, rankedSymbols: sessionRows.length };
  }, [highlights]);

  // Holders grouped by SYMBOL for the card: one parent row per symbol with
  // every real-person record preserved as a separate child (client spec:
  // each person shown vertically underneath, never aggregated/deduplicated).
  // ownershipPct from the API is already a percent (holder-records.ts ×100) —
  // display it as-is; the earlier ×100 here produced impossible values >100.
  const allHighlightHoldingGroups = useMemo(() => {
    return groupHolderRowsBySymbol((highlightHoldings?.rows ?? []).map((r) => ({
      ...r, key: r.id, currentCompact: compactSharesEn(r.currentShares),
      signedChange: signedSharesEn(r.changeShares),
      ownershipText: r.ownershipPct === null ? null : faN.format(r.ownershipPct),
    }))).map((group) => ({ ...group, children: group.children.map((child, index) => ({ ...child, label: `شخص حقیقی ${faI.format(index + 1)}` })) }));
  }, [highlightHoldings]);
  const highlightHoldingGroups = showAllHighlightHolders ? allHighlightHoldingGroups : allHighlightHoldingGroups.slice(0, 20);

  // ══════════════════════════════════════════════════════════════════════════
  // TAB CONTENT RENDERERS
  // ══════════════════════════════════════════════════════════════════════════
  function renderFilterModes() {
    return <div className="mode-switch" aria-label="نوع نمایش">
      {([
        ["all", "همه نمادها"],
        ["peakDrop", `افت از سقف ${peakDropPeriod === "1m" ? "۱ ماهه" : peakDropPeriod === "2m" ? "۲ ماهه" : "۳ ماهه"}`],
        ["rsiOversold", "فقط RSI ≤ ۳۰"],
        ["combined", "ترکیب افت + RSI"],
        ["selectedOnly", "⭐ منتخب‌ها"],
        ["bullDiv", "🟢 واگرایی مثبت"],
        ["bearDiv", "🔴 واگرایی منفی"],
        ["epsSectorPe", "🟢 EPS × P/E گروه"],
        ["peBelowSector", "🟢 P/E سهم < گروه"],
        ["holderBuys", "🟢 خرید حقیقی عمده"],
        ["holderSells", "🔴 فروش حقیقی عمده"],
      ] as [DisplayMode, string][]).map(([v, l]) => <button className={displayMode === v ? "active" : ""} key={v} onClick={() => { setDisplayMode(v); if (v === "epsSectorPe") { setSortCol("epsSectorPeUpsidePct"); setSortDir("desc"); } }} type="button">{l}</button>)}
      {displayMode === "peakDrop" && <div className="period-select">
        {(["1m", "2m", "3m"] as const).map((p) => <button key={p} className={peakDropPeriod === p ? "active" : ""} onClick={() => setPeakDropPeriod(p)} type="button">{p === "1m" ? "۱ ماه" : p === "2m" ? "۲ ماه" : "۳ ماه"}</button>)}
      </div>}
    </div>;
  }

  function renderHighlightsPanel() {
    const shownSessionDate = highlightGroups.sessionDate ?? highlightSessionDate;
    const coverage = highlightCoverage(highlights, getScopeSymbols(highlightScope).length);
    const datedSessions = new Set(highlights.map(row => row.sessionDate).filter(Boolean));
    const olderCommodityRows = highlights.filter(row => isThursdayCommodityInstrument(row.name)
      && row.sessionDate != null && row.sessionDate < expectedHighlightSession(row.name)
      && expectedHighlightSession(row.name) > expectedDate());
    const priceIncomplete = coverage.datedPrices < coverage.requested || coverage.volume < coverage.requested
      || coverage.value < coverage.requested || coverage.cached > 0;
    return <section className="panel highlights-panel">
      <div className="panel-head">
        <div><p className="eyebrow">رتبه‌بندی روزانه فهرست فعال</p><h2>بیشترین‌های بازار برای نمادهای {scopeLabel(highlightScope)}</h2></div>
        <button className="primary-button" disabled={highlightsLoading} onClick={() => void fetchMarketHighlights(highlightScope, getScopeSymbols(highlightScope))} type="button">
          <span aria-hidden="true">↻</span> {highlightsLoading ? "در حال بروزرسانی…" : "بروزرسانی رتبه‌بندی‌ها"}
        </button>
      </div>
      <div className="scan-scopes" role="group" aria-label="محدوده اسکن بیشترین‌ها">{(["haghighi", "zarbanana", "custom", "all"] as WatchlistScope[]).map((scope) => <button key={scope} type="button" aria-pressed={highlightScope === scope} className={`source-chip ${highlightScope === scope ? "active" : ""}`} onClick={() => void fetchMarketHighlights(scope, getScopeSymbols(scope))}>اسکن {scopeLabel(scope)} ({faI.format(getScopeSymbols(scope).length)})</button>)}</div>
      {highlightsError && <p className="scan-error" role="alert">{highlightsError}{highlights.length ? "؛ آخرین نتیجه همین فهرست نمایش داده می‌شود." : "؛ اسکن کامل نشده است."}</p>}
      <div className="highlights-intro">
        <div className="highlights-intro-line"><strong>فقط نمادهای فهرست خودمان</strong><span className="session-date-badge">تاریخ داده: <b>{shownSessionDate ? fmtDate(shownSessionDate) : highlights.length ? "تاریخ منبع نامشخص" : "در انتظار دریافت"}</b></span></div>
        <p>این رتبه‌ها از نمادهای فهرست فعال ساخته می‌شوند و به جدول‌های ۹۰/۱۸۰ روزه یا حقیقی‌های عمده چیزی اضافه نمی‌کنند. چهار کارت معاملاتی ۱۰ نماد برتر را نشان می‌دهند؛ در کارت تغییرات سهامداران، ۲۰ نماد اول و در صورت درخواست، همه نتایج دریافت‌شده قابل مشاهده است.</p>
        {priceIncomplete && <p className="partial-data-note">پوشش قیمت، حجم یا ارزش معاملات کامل نیست؛ رتبه‌بندی فقط از داده‌های تاریخ‌دار معتبر و کش مشخص ساخته شده است.</p>}
        {datedSessions.size > 1 && <p className="partial-data-note">داده‌ها مربوط به چند جلسه معاملاتی‌اند. برای جلوگیری از ترکیب جلسه‌ها، کارت‌های روزانه فقط {faI.format(highlightGroups.rankedSymbols)} نماد مربوط به جلسه غالب {fmtDate(shownSessionDate)} را رتبه‌بندی می‌کنند.</p>}
        {olderCommodityRows.length > 0 && <p className="partial-data-note">داده {faI.format(olderCommodityRows.length)} ابزار کالایی که ممکن است پنجشنبه معامله شده باشند، هنوز به آخرین جلسه مورد انتظار نرسیده است؛ تاریخ مشاهده‌شده هر نماد ملاک است، نه زمان بروزرسانی.</p>}
        {highlightClientTypeUnavailable && <p className="partial-data-note">قیمت‌ها دریافت شد، اما جزئیات حجم خرید و فروش حقیقی موقتاً از منبع رسمی در دسترس نبود.</p>}
        {highlights.some((row) => !row.sessionDate) && <p className="partial-data-note">تاریخ قیمت بعضی نمادها در منبع قابل تأیید نیست؛ زمان بروزرسانی به معنی تاریخ معامله نیست.</p>}
        {highlights.some((row) => !row.floorVerified) && <p className="partial-data-note">کف مجاز همان روز برای بعضی نمادها تأیید نشد؛ آن‌ها وارد فیلتر بازگشت از کف مجاز نمی‌شوند.</p>}
      </div>
      <p className="partial-data-note" role="status">پوشش از {faI.format(coverage.requested)} نماد: قیمت تاریخ‌دار {faI.format(coverage.datedPrices)}، حجم {faI.format(coverage.volume)}، ارزش معاملات {faI.format(coverage.value)}، حجم حقیقی {faI.format(coverage.clientType)}، ارزش حقیقی {faI.format(coverage.realValues)}، کف مجاز {faI.format(coverage.floor)}؛ دریافت‌نشده {faI.format(coverage.unreceived)}، دادهٔ قبلی {faI.format(coverage.cached)}.</p>
      <div className="highlight-grid">
        <HighlightCard number="۱" title="بیشترین ارزش معاملات" subtitle="ارزش ریالی معاملات آخرین جلسه" icon="◆" rows={highlightGroups.values} emptyText="داده ارزش معاملات برای این فهرست موجود نیست." />
        <HighlightCard number="۲" title="بیشترین حجم معاملات" subtitle="تعداد سهام معامله‌شده در آخرین جلسه" icon="▥" rows={highlightGroups.volumes} emptyText="داده حجم معاملات برای این فهرست موجود نیست." />
        <HighlightCard number="۳" title="بیشترین ورود پول حقیقی" subtitle="خالص ارزش خرید حقیقی" icon="↗" rows={highlightGroups.realMoney} emptyText={emptyDataMessage("money", coverage.realValues, coverage.requested)} />
        <ReversalHighlightCard rows={highlightGroups.reversals} emptyText={emptyDataMessage("floor", coverage.floor, coverage.requested)} />
        <article className="highlight-card holder-highlight-card">
          <header><div className="highlight-heading"><span className="highlight-icon" aria-hidden="true">↗</span><div><h3>تغییرات سهامدار حقیقی</h3><p>هر ردیف یک سهامدار عمده حقیقی با افزایش سهم</p></div></div><span className="highlight-number">۵</span></header>
          <p className="holder-highlight-status">{highlightHoldingsLoading ? "در حال دریافت… " : ""}تاریخ تغییرات: {fmtDate(highlightHoldings?.sourceDate)}{highlightHoldings?.fallback ? " · داده پشتیبان" : ""}{highlightHoldings?.partial ? " · اسکن ناقص" : ""}{highlightHoldings?.fetchedAt ? ` · ${highlightHoldings.fallback ? "زمان ثبت نسخه پشتیبان" : "زمان دریافت"}: ${faDT.format(new Date(highlightHoldings.fetchedAt))}` : ""}</p>
          {!highlightHoldingsLoading && highlightHoldings?.partial && highlightHoldings.rows.length > 0 && <p className="partial-data-note">فعلاً {faI.format(groupHolderRowsBySymbol(highlightHoldings.rows).length)} نماد دارای افزایش تأییدشده دریافت شده است. چون دریافت ناقص بوده، این عدد تعداد کل افزایش‌ها در فهرست نیست.</p>}
          {highlightHoldings?.partial && highlightHoldings.warning && <p className="partial-data-note">{highlightHoldings.warning}</p>}
          {allHighlightHoldingGroups.length > 0 && <p className="holder-highlight-status" role="status">نمایش {faI.format(highlightHoldingGroups.length)} نماد از {faI.format(allHighlightHoldingGroups.length)} نماد دارای افزایش سهم در داده دریافت‌شده؛ {highlightHoldings?.fallback ? "این نتایج تاریخی هستند و خرید امروز را تأیید نمی‌کنند." : "تاریخ و پوشش منبع را بررسی کنید."}</p>}
          {highlightHoldings && <p className="holder-freshness warning-text" role="status">{holderFreshnessText(highlightHoldings, expectedDate())}</p>}
          {highlightHoldingsError && <p className="scan-error" role="alert">{highlightHoldingsError}{highlightHoldings ? "؛ نتیجه قبلی همین فهرست نمایش داده می‌شود." : "؛ اسکن کامل نشده است."}</p>}
          <div className="holder-groups"><table aria-label="تغییرات سهامدار حقیقی به تفکیک نماد"><tbody>
            {highlightHoldingGroups.map((group) => {
              const isOpen = highlightOpenGroups.has(group.symbol);
              const representative = group.representative;
              return [
                <tr className="holder-group-head" key={`${group.id}-head`}>
                  <td>
                    <button className="holder-expand-button" aria-expanded={isOpen} type="button" onClick={() => toggleHighlightGroup(group.symbol)}>
                      <strong>{group.symbol}</strong>
                      <span className="holder-people-inline" title="تعداد سهامداران حقیقی عمده این نماد">{faI.format(group.people)} شخص حقیقی</span>
                      <span className="holder-caret" aria-hidden="true">{isOpen ? "▴" : "▾"}</span>
                      <small className="holder-head-sub">{group.instrumentName}{group.market ? ` · ${group.market}` : ""}</small>
                    </button>
                    <CopySymbol symbol={group.symbol} />
                  </td>
                  <td><small>بیشترین دارنده · سهام فعلی</small><b dir="ltr">{representative.currentCompact}</b></td>
                  <td><small>تغییر همان شخص</small><b dir="ltr" className="positive">{representative.signedChange}</b><small className="holder-date">{fmtDate(representative.date)}</small></td>
                  <td><small>درصد مالکیت</small><OwnershipValue row={representative} /></td>
                </tr>,
                ...(isOpen ? group.children.map((child) => <tr key={child.key} className="holder-person-row">
                  <td><span className="holder-person-name">{child.label}</span></td>
                  <td><small>تعداد سهام فعلی</small><b dir="ltr">{child.currentCompact}</b></td>
                  <td><small>{child.changeShares > 0 ? "افزایش سهم" : child.changeShares < 0 ? "کاهش سهم" : "بدون تغییر"}</small><b dir="ltr" className={child.changeShares > 0 ? "positive" : child.changeShares < 0 ? "negative" : ""}>{child.signedChange}</b></td>
                  <td><small>درصد مالکیت</small><OwnershipValue row={child} /><small className="holder-date">{fmtDate(child.date)}</small></td>
                </tr>) : []),
              ];
            })}
          </tbody></table></div>
          {allHighlightHoldingGroups.length > 20 && <div className="holder-highlight-more">
            <button className="source-chip" type="button" aria-expanded={showAllHighlightHolders} onClick={() => setShowAllHighlightHolders((value) => !value)}>
              {showAllHighlightHolders ? "نمایش ۲۰ نماد برتر" : `نمایش همه ${faI.format(allHighlightHoldingGroups.length)} نماد دریافت‌شده`}
            </button>
            <span>افزایش تعداد ردیف‌ها فقط داده‌های موجود را نمایش می‌دهد؛ اسکن زنده جدیدی انجام نمی‌شود.</span>
          </div>}
          {!highlightHoldingsLoading && !highlightHoldingsError && highlightHoldings && !highlightHoldings.rows.length && <div className="highlight-empty">{highlightHoldings.partial ? "دریافت ناقص است؛ نبود خرید قابل تأیید نیست." : "در جلسه این منبع افزایش سهمی برای این فهرست ثبت نشده است."}</div>}
        </article>
      </div>
      <footer className="panel-foot"><span>{faI.format(highlights.length)} نماد از فهرست {scopeLabel(highlightScope)}</span><span>{highlightsUpdatedAt ? `آخرین بروزرسانی: ${faDT.format(highlightsUpdatedAt)}` : "برای دریافت رتبه‌ها، بروزرسانی را بزن."}</span></footer>
    </section>;
  }

  function renderSummaryGrid() {
    return <section className="summary-grid" aria-label="خلاصه فیلتر">
      <article><span>نمادهای فهرست {sourceLabel(activeSource)}</span><strong>{faI.format(currentRows.length)}</strong><small>فقط همین نمادها فیلتر می‌شوند</small></article>
      <article><span>بیشترین فاصله از سقف</span><strong className="negative">{drop(biggestDD)}</strong><small>حقیقی عمده آماده: {faI.format(readyHolder)} نماد</small></article>
      <article><span>بازده مثبت دوره</span><strong className="positive">{faI.format(posCount)}</strong><small>قیمت ابتدای دوره تا آخرین پایانی</small></article>
      <article><span>بازده منفی دوره</span><strong className="negative">{faI.format(negCount)}</strong><small>نمادهایی که نسبت به ابتدای دوره افت کرده‌اند</small></article>
      <article><span>RSI زیر یا مساوی ۳۰</span><strong className="warning-text">{faI.format(oversoldCount)}</strong><small>RSI استاندارد ۱۲ روزه · مبنای آخرین معامله روز</small></article>
      <article><span>🟢 واگرایی مثبت (RD+ / HD+)</span><strong className="positive">{faI.format(bullishDivCount)}</strong><small>کف‌های تأییدشده قیمت و RSI · معمولی یا مخفی</small></article>
      <article><span>🔴 واگرایی منفی (RD− / HD−)</span><strong className="negative">{faI.format(bearishDivCount)}</strong><small>سقف‌های تأییدشده قیمت و RSI · معمولی یا مخفی</small></article>
      <article><span>🟢 EPS × P/E گروه</span><strong className="positive">{faI.format(epsSectorPeCount)}</strong><small>برآورد گروه بالاتر از قیمت پایانی</small></article>
      <article><span>🟢 P/E سهم و گروه</span><strong className="positive">{faI.format(peBelowSectorCount)}</strong><small>P/E سهم کمتر از P/E گروه</small></article>
    </section>;
  }

  function renderDefinitionCard() {
    if (displayMode === "peakDrop") {
      const days = peakDropPeriod === "1m" ? 30 : peakDropPeriod === "2m" ? 60 : 90;
      return <section className="definition-card"><div className="definition-icon" aria-hidden="true">i</div><div><strong>افت از سقف {faI.format(days)} روز تقویمی</strong><p>قیمت ابتدا، سقف، بازده و افت جدول برای <b>{faI.format(days)} روز تقویمی</b> قبل از آخرین جلسه موجود محاسبه می‌شوند. همه قیمت‌ها با واحد <b>ریال</b> هستند.</p></div></section>;
    }
    return <section className="definition-card"><div className="definition-icon" aria-hidden="true">i</div><div><strong>روش محاسبه دقیق دوره</strong><p>بازه از <b>۹۰/۱۸۰ روز تقویمی</b> قبل از آخرین جلسه موجود محاسبه می‌شود. <b>بازده دوره</b> قیمت آن جلسه را با آخرین قیمت پایانی مقایسه می‌کند و <b>افت از سقف</b> فاصله آخرین پایانی تا بالاترین قیمت روزانه همان بازه است. همه قیمت‌ها با واحد <b>ریال</b> نمایش داده می‌شوند.</p></div></section>;
  }

  function renderDataTable(rows: ScreenerRow[]) {
    return <div className="table-wrap"><table><thead><tr>
      <th><SortBtn active={sortCol} column="symbol" direction={sortDir} label="نماد" onSort={doSort} /></th>
      <th><SortBtn active={sortCol} column="realHolders" direction={sortDir} label="تعداد حقیقی عمده" onSort={doSort} /></th>
      <th><SortBtn active={sortCol} column="startPrice" direction={sortDir} label="قیمت ابتدای دوره (ریال)" onSort={doSort} /></th>
      <th><SortBtn active={sortCol} column="peakPrice" direction={sortDir} label="بالاترین قیمت دوره (ریال)" onSort={doSort} /></th>
      <th><SortBtn active={sortCol} column="currentPrice" direction={sortDir} label="آخرین قیمت پایانی (ریال)" onSort={doSort} /></th>
      <th><SortBtn active={sortCol} column="returnPct" direction={sortDir} label="رشد / ریزش دوره" onSort={doSort} /></th>
      <th><SortBtn active={sortCol} column="drawdownPct" direction={sortDir} label="افت از سقف" onSort={doSort} /></th>
      <th><SortBtn active={sortCol} column="rsi" direction={sortDir} label="RSI ۱۲" onSort={doSort} /></th>
      <th>واگرایی</th>
      <th><SortBtn active={sortCol} column="holderBuys" direction={sortDir} label="خرید حقیقی" onSort={doSort} /></th>
      <th><SortBtn active={sortCol} column="epsSectorPeUpsidePct" direction={sortDir} label="EPS × P/E گروه" onSort={doSort} /></th>
      <th><SortBtn active={sortCol} column="peBelowSector" direction={sortDir} label="P/E سهم / P/E گروه" onSort={doSort} /></th>
      <th>افزایش سرمایه / تعدیل</th>
    </tr></thead><tbody>{rows.map((row) => {
      const m = gm(row, period);
      const actionStart = m ? Number(m.startDate) : row.priceQuote
        ? subtractCalendarDays(row.priceQuote.sessionDate, period === "3m" ? 90 : 180) : null;
      const rel = row.actions.filter((a) => actionStart !== null && Number(a.date) >= actionStart);
      const alert = row.status !== "ready" || rel.length > 0;
      const div = row.divergence;
      const valuation = row.valuation;
      const quoteSession = screenerQuoteSession(row);
      const earlierThanCalendar = Boolean(quoteSession && quoteSession < expectedDate());
      const holderChange = holderChangeSummaries[normalizeSymbol(row.symbol)];
      return <tr className={row.status === "error" ? "row-error" : ""} key={row.symbol}>
        <td><div className="symbol-cell">
          <button className={`star-button ${sharedFavs.has(normalizeSymbol(row.symbol)) ? "is-active" : ""}`} onClick={() => toggleFav(row.symbol)} title={sharedFavs.has(normalizeSymbol(row.symbol)) ? "حذف از منتخب‌ها" : "افزودن به منتخب‌ها"} type="button">⭐</button>
          <strong>{row.symbol}{alert && <span className="row-alert" title={row.note}>!</span>}</strong><span>{row.name || row.note}</span>
        </div></td>
        <td><strong className="holder-count-inline">{row.realHolders === null ? (holderScanning ? "…" : "—") : faI.format(row.realHolders)}</strong><small>ردیف با نام «شخص حقیقی»</small></td>
        <td><PriceCell sub={m ? `از ${fmtDate(m.startDate)}` : undefined} value={m?.startPrice} /></td>
        <td><PriceCell sub={m ? fmtDate(m.peakDate) : undefined} value={m?.peakPrice} /></td>
        <td><PriceCell sub={m ? fmtDate(m.currentDate) : row.priceQuote ? fmtDate(row.priceQuote.sessionDate) : undefined}
          value={m?.currentPrice ?? row.priceQuote?.closeRial} />
          {earlierThanCalendar && <small className="warning-text" title="این مقایسه صرفاً تقویمی است؛ توقف نماد یا تعطیلی استثنایی بازار بررسی نشده است.">قدیمی‌تر از جلسه مورد انتظار؛ معامله‌نشدن نماد یا تأخیر منبع نامشخص است</small>}
          {row.quoteVerified === false && <small className="warning-text">تازگی قیمت تأیید نشد</small>}</td>
        <td><span className={`metric-pill ${(m?.returnPct ?? 0) > 0 ? "up" : (m?.returnPct ?? 0) < 0 ? "down" : "flat"}`}>{pct(m?.returnPct)}</span></td>
        <td><span className={`metric-pill ${(m?.drawdownPct ?? 0) > 0 ? "down" : "flat"}`}>{drop(m?.drawdownPct)}</span></td>
        <td><span className={`rsi-value ${row.rsi !== null && row.rsi <= 30 ? "oversold" : ""}`}>{row.rsi === null ? "—" : faN.format(row.rsi)}</span></td>
        <td><button type="button" className="divergence-inspect" onClick={() => setDivergenceView(row)} aria-label={`تحلیل واگرایی ${row.symbol}`}>
          {div ? <span className={`divergence-pill ${div.kind === "positive" ? "div-bullish" : "div-bearish"}`}>{div.label}</span> : <span className="muted">{row.divergenceAnalysis && row.divergenceAnalysis.status === "insufficient" ? "داده کافی نیست" : row.divergenceAnalysis && row.divergenceAnalysis.status === "stale" ? "داده قدیمی است" : row.divergenceAnalysis && row.divergenceAnalysis.status === "unverified" ? "داده ناقص برای واگرایی" : row.divergenceAnalysis && row.divergenceAnalysis.status === "adjustment" ? "در انتظار تأیید افزایش سرمایه" : row.divergenceAnalysis && row.divergenceAnalysis.status === "invalid" ? "داده نامعتبر" : "بدون واگرایی"}</span>}
          <small>مشاهده جزئیات</small></button></td>
        <td><HolderChangeCell loading={holderChangesLoading} summary={holderChange} meta={holderChangeMeta[normalizeSymbol(row.symbol)]} /></td>
        <td><div className={`valuation-cell ${valuation?.epsSectorPePositive ? "is-positive" : ""}`}>
          {valuation?.epsSectorPePositive && <span className="positive-dot" title="حالت مثبت" />}
          <strong>{valuation?.epsSectorPePrice === null || valuation?.epsSectorPePrice === undefined ? "—" : faI.format(valuation.epsSectorPePrice)}</strong>
          <small className="valuation-upside">{valuation?.epsSectorPeUpsidePct === null || valuation?.epsSectorPeUpsidePct === undefined ? "EPS یا P/E گروه معتبر نیست" : `${pct(valuation.epsSectorPeUpsidePct)} نسبت به پایانی`}</small>
        </div></td>
        <td><div className={`valuation-cell ${valuation?.peBelowSector ? "is-positive" : ""}`}>
          {valuation?.peBelowSector && <span className="positive-dot" title="حالت مثبت" />}
          <div className="pe-pair">
            <span className="pe-pair-item"><small>P/E سهم</small><b dir="ltr">{valuation && valuation.pe > 0 ? faN.format(valuation.pe) : "—"}</b></span>
            <span className="pe-pair-item"><small>P/E گروه</small><b dir="ltr">{valuation && valuation.sectorPe > 0 ? faN.format(valuation.sectorPe) : "—"}</b></span>
          </div>
        </div></td>
        <td>{rel.length ? <button className="event-button" onClick={() => setActionView({ row, actions: rel, period })} type="button"><span className={rel.some((a) => a.confirmed) ? "verified" : "estimated"} /> {faI.format(rel.length)} رویداد</button> : <span className="muted">در این دوره ثبت نشد</span>}</td>
      </tr>;
    })}</tbody></table>{!rows.length && <div className="empty-state">{loading ? <><span className="spinner" /> در حال محاسبه…</> : "برای این شرط، ردیفی وجود ندارد."}</div>}</div>;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════

  return <main className="app-shell">
    {/* ── TOPBAR ── */}
    <header className="topbar">
      <div className="topbar-inner">
        <div className="brand-block"><span className="brand-mark" aria-hidden="true">ب</span><div><p className="eyebrow">دیده‌بان شخصی بازار سرمایه</p><div className="brand-title-line"><h1>فیلتر بورس ایران</h1></div></div></div>
        <div className="topbar-actions">
          <div className="session-state"><span className={`status-dot${behindExpected ? " status-dot-warn" : ""}`} title={behindExpected ? "منبع هنوز جلسه امروز را منتشر نکرده است" : undefined} /><div><strong>آخرین جلسه موجود در منبع</strong><span>{latestDate ? fmtDate(latestDate) : loading ? "در حال دریافت داده…" : sourceErrors[activeSource] ? "دریافت داده ناموفق بود" : "داده‌ای دریافت نشده است"}{lastUpdated ? ` · بررسی ${faDT.format(lastUpdated)}` : ""}</span></div></div>
          {/* ── 3 Source management buttons ── */}
          {(["haghighi", "zarbanana", "custom"] as SourceKey[]).map((src) => (
            <button key={src} className={`secondary-button ${activeSource === src ? "source-active" : ""}`} onClick={() => openMgr(src)} type="button">
              مدیریت نماد {sourceLabel(src)} <span className="count-badge">{faI.format(sourceCount(src))}</span>
            </button>
          ))}
          <button className="primary-button" disabled={activeTab === "highlights" ? highlightsLoading : activeTab === "holderIncreases" ? holderIncreaseLoading : activeTab === "holders" ? marketLoading || holderScanning : loading} onClick={() => {
            if (activeTab === "highlights") void fetchMarketHighlights(highlightScope, getScopeSymbols(highlightScope));
            else if (activeTab === "holderIncreases") void fetchHolderIncreases();
            else if (activeTab === "holders") void startMarketScan();
            else void fetchSourceData(activeSource, getSourceSymbols(activeSource));
          }} type="button"><span aria-hidden="true">↻</span> {activeTab === "highlights" ? highlightsLoading ? "در حال بروزرسانی…" : "بروزرسانی رتبه‌بندی" : activeTab === "holderIncreases" ? holderIncreaseLoading ? "در حال دریافت…" : "بروزرسانی تغییرات" : activeTab === "holders" ? holderScanning ? "در حال اسکن…" : "اسکن کل بازار" : loading ? "در حال بروزرسانی…" : "بروزرسانی اطلاعات"}</button>
        </div>
      </div>
    </header>

    <section className="workspace">
      {storageWriteFailed && <p className="scan-error" role="alert">ذخیره‌سازی مرورگر محدود یا غیرفعال است؛ تغییرات فهرست و منتخب‌ها ممکن است بعد از بستن یا تازه‌کردن صفحه از بین بروند. برای نگهداری فهرست از خروجی TXT استفاده کنید.</p>}
      {/* ── TABS ── */}
      <nav className="tabs" aria-label="فیلترهای اصلی" style={{ direction: "rtl" }}>
        <button className={activeTab === "3m" ? "active" : ""} onClick={() => setActiveTab("3m")} type="button"><span>۹۰</span> فیلتر ۹۰ روزه</button>
        <button className={activeTab === "6m" ? "active" : ""} onClick={() => setActiveTab("6m")} type="button"><span>۱۸۰</span> فیلتر ۱۸۰ روزه</button>
        <button className={activeTab === "highlights" ? "active" : ""} onClick={() => {
          setActiveTab("highlights");
          // Switching tabs is not a reason to recalculate a ranking that already
          // belongs to the latest closed session.
          if (!highlights.length || !highlightSessionDate || highlightSessionDate < lastClosedEquitySession()) void fetchMarketHighlights(highlightScope, getScopeSymbols(highlightScope));
        }} type="button"><span>۵</span> بیشترین‌های فهرست</button>
        <button className={activeTab === "holders" ? "active" : ""} onClick={() => setActiveTab("holders")} type="button"><span>ح</span> حقیقی‌های عمده کل بازار</button>
        <button className={activeTab === "holderIncreases" ? "active" : ""} onClick={() => {
          setActiveTab("holderIncreases");
          if (!holderIncreaseRows.length || !holderIncreaseDate || holderIncreaseDate < lastClosedEquitySession()) void fetchHolderIncreases();
        }} type="button"><span>خ</span> خرید حقیقی عمده</button>
        <button className={activeTab === "selected" ? "active" : ""} onClick={() => { setActiveTab("selected"); void loadMissingFavorites(); }} type="button">⭐ نمادهای منتخب {sharedFavs.size > 0 && <span className="count-badge tab-count">{faI.format(sharedFavs.size)}</span>}</button>
      </nav>

      {/* ── Active source indicator ── */}
      {(activeTab === "3m" || activeTab === "6m") && <div className="source-indicator">
        <span className="source-label">فهرست فعال:</span>
        {(["haghighi", "zarbanana", "custom"] as SourceKey[]).map((src) => (
          <button key={src} className={`source-chip ${activeSource === src ? "active" : ""}`} onClick={() => {
            setActiveSource(src);
            persistPreference(K_ACTIVE_SOURCE, src);
            const symbols = getSourceSymbols(src);
            if (!symbols.length) return;
            const rows = getSourceRows(src);
            const now = new Date();
            // Another list is fetched on demand, but a stored snapshot of the
            // expected session is shown without a new request.
            if (!screenerNeedsRefresh(rows, now, { loadedSession: screenerRowsSession(rows, now), verification: verificationRef.current[src] })) return;
            void fetchSourceData(src, symbols);
          }} type="button">
            {sourceLabel(src)} ({faI.format(sourceCount(src))})
          </button>
        ))}
        <button className="scan-list-btn" onClick={() => {
          if (holderScanning && holderScope === sourceLabel(activeSource)) { stopHolderScan(); return; }
          void scanHolders(getSourceSymbols(activeSource), false, sourceLabel(activeSource));
        }} type="button">{holderScanning && holderScope === sourceLabel(activeSource) ? "توقف اسکن" : `اسکن حقیقی‌های ${sourceLabel(activeSource)}`}</button>
      </div>}

      <div className="notice" role="status"><span aria-hidden="true">●</span><span className="notice-copy">{activeNotice}</span>{activeTab === "holders" && holderScanning && <progress max={holderProgress.total || 1} value={holderProgress.done} />}</div>
      {(activeTab === "3m" || activeTab === "6m") && allRowsConfirmed && activeRowsSession &&
        <p className="refresh-assurance" role="status">قیمت‌های پایانی جلسه {fmtDate(activeRowsSession)} تأیید شد؛ بروزرسانی بعدی {nextSessionWeekday} ساعت ۱۳:۰۵</p>}

      {/* ── 3m / 6m TABS (data from active source) ── */}
      {(activeTab === "3m" || activeTab === "6m") && <section className="panel">
        <div className="panel-head">
          <div><p className="eyebrow">خروجی واقعی و مرتب‌شونده</p><h2>عملکرد {displayMode === "peakDrop" ? `${faI.format(peakDropPeriod === "1m" ? 30 : peakDropPeriod === "2m" ? 60 : 90)} روزه` : period === "3m" ? "۹۰ روزه" : "۱۸۰ روزه"} نمادهای {sourceLabel(activeSource)}</h2></div>
          <div className="panel-controls">
            <input aria-label="جستجو در نمادها" onChange={(e) => setSearchDraft(e.target.value)} placeholder="جستجوی نماد…" type="search" value={searchDraft} />
            {renderFilterModes()}
          </div>
        </div>
        {renderSummaryGrid()}
        {renderDefinitionCard()}
        {renderDataTable(filteredRows)}
        <footer className="panel-foot"><span>{faI.format(filteredRows.length)} ردیف از {faI.format(enrichedRows.length)} نماد</span><span>{lastUpdated ? `آخرین بروزرسانی: ${faDT.format(lastUpdated)}` : "برای مرتب‌سازی روی عنوان هر ستون کلیک کن."}</span></footer>
      </section>}

      {activeTab === "highlights" && renderHighlightsPanel()}

      {/* ── HOLDERS (کل بازار) TAB ── */}
      {activeTab === "holders" && <section className="panel holders-panel">
        <div className="panel-head">
          <div><p className="eyebrow">فیلتر مستقل کل بورس و فرابورس</p><h2>تعداد سهامداران عمده «شخص حقیقی»</h2></div>
          <div className="holders-actions"><input aria-label="جستجو" onChange={(e) => setMarketSearch(e.target.value)} placeholder="جستجوی نماد…" type="search" value={marketSearch} /><button className="primary-button" disabled={marketLoading} onClick={() => void startMarketScan()} type="button">{holderScanning && holderScope === "کل بازار" ? "توقف اسکن" : marketLoading ? "دریافت فهرست…" : marketUniverse.length ? "شروع / ادامه اسکن" : "اسکن کل بازار"}</button></div>
        </div>
        <div className="holders-intro"><strong>مبنای درست شمارش و نمایش کامل</strong><p>این بخش مستقل از فهرست شخصی است و کل نمادهای عادی بورس و فرابورس را بررسی می‌کند. زمان تقریبی اسکن: {scanEst(marketUniverse.length)}.</p></div>
        <div className="market-stat"><span>نمادهای دریافت‌شده: <b>{faI.format(marketUniverse.length)}</b></span><span>تعداد شمارش‌شده: <b>{faI.format(marketUniverse.filter((i) => holderMeta[i.symbol]?.status === "verified" || holderMeta[i.symbol]?.status === "verified-zero").length)}</b></span><span>در صف / ناموفق: <b>{faI.format(marketUniverse.filter((i) => { const m = holderMeta[i.symbol]; return !m || !["verified", "verified-zero"].includes(m.status); }).length)}</b></span></div>
        {marketUniversePartial && <div className="warning-text">فهرست بازار ناقص دریافت شده است؛ {faI.format(marketUniverse.length)} نماد معتبر برای اسکن در دسترس است و پوشش کل بازار تأیید نشده است.</div>}
        {marketUniverse.length > 0 && <div className="warning-text">منبع تعداد سهامداران تاریخ جلسه معاملاتی را ارائه نمی‌کند؛ زمان دریافت به‌معنی تاریخ واقعی منبع نیست.</div>}
        {!marketUniverse.length ? <div className="empty-state">برای ساخت جدول کامل، «اسکن کل بازار» را بزن.</div> : marketUniverse.every((i) => { const m = holderMeta[i.symbol]; return !m || m.status === "pending" || m.status === "timeout" || m.status === "failed" || m.status === "unavailable"; }) ? <div className="warning-text">هنوز نتیجه تأییدشده‌ای وجود ندارد؛ اسکن انجام نشده یا درخواست‌ها ناموفق بوده‌اند.</div> : marketUniverse.some((i) => holderMeta[i.symbol]?.partial || !holderMeta[i.symbol] || !["verified", "verified-zero"].includes(holderMeta[i.symbol].status)) ? <div className="warning-text">فقط نتایج تأییدشده نمایش داده می‌شوند؛ بررسی سایر نمادها هنوز کامل نشده است.</div> : null}
        <div className="table-wrap compact-table holders-scroll"><table><thead><tr>
          <th className="rank-head">رتبه کل بازار</th>
          <th><SortBtn active={holderSortCol} column="symbol" direction={holderSortDir} label="نماد" onSort={sortHolders} /></th>
          <th><SortBtn active={holderSortCol} column="realHolders" direction={holderSortDir} label="تعداد حقیقی عمده" onSort={sortHolders} /></th>
          <th>وضعیت</th>
        </tr></thead><tbody>{sortedHolderRows.map((r) => {
          const meta = holderMeta[r.symbol];
          const statusLabel = !meta ? "در صف اسکن" : meta.delivery === "cache" && meta.lastRefreshFailure ? "شمارش قبلی · بروزرسانی ناموفق" : meta.status === "verified" ? "دریافت‌شده" : meta.status === "verified-zero" ? "بدون حقیقی عمده تأییدشده" : meta.status === "processing" ? "در حال بررسی" : meta.status === "pending" ? "در صف اسکن" : meta.status === "timeout" ? "مهلت تمام شد" : meta.status === "failed" ? "خطای درخواست" : meta.status === "invalid-source" ? "پاسخ نامعتبر منبع" : meta.status === "unavailable" ? "دسترس‌نبود" : "در صف اسکن";
          const statusClass = !meta ? "pending" : meta.delivery === "cache" && meta.lastRefreshFailure ? "failed" : meta.status === "verified" || meta.status === "verified-zero" ? "" : "failed";
          return <tr key={r.symbol}>
            <td><strong className="rank-value">{holderRanks[r.symbol] ? faI.format(holderRanks[r.symbol]) : "—"}</strong></td>
            <td><div className="symbol-cell"><strong>{r.symbol}</strong><span>{r.name}</span></div></td>
            <td><strong className="holder-count">{r.realHolders === null ? "—" : faI.format(r.realHolders)}</strong></td>
            <td>{meta?.retrievedAt ? <small className="holder-date">آخرین دریافت موفق: {faDT.format(new Date(meta.retrievedAt))}</small> : <span />}{meta?.sourceDate ? <small className="holder-date">منبع: {fmtDate(meta.sourceDate)}</small> : <span />}{meta?.checkedSession && !meta.sourceDate && <small className="holder-date">جلسه مورد انتظار هنگام درخواست: {fmtDate(meta.checkedSession)} (تاریخ منبع تأیید نشده)</small>}<span className={`source-state ${statusClass}`}><span className="status-dot" />{statusLabel}</span></td>
          </tr>;
        })}</tbody></table>{!marketUniverse.length && !marketLoading && <div className="empty-state">برای ساخت جدول کامل، «اسکن کل بازار» را بزن.</div>}</div>
      </section>}

      {/* ── MAJOR INDIVIDUAL HOLDER INCREASES (کل بازار) ── */}
      {activeTab === "holderIncreases" && <section className="panel holders-panel">
        <div className="panel-head">
          <div><p className="eyebrow">تغییرات سهامداران {scopeLabel(increaseScope)}</p><h2>خرید / افزایش سهام سهامداران عمده حقیقی</h2></div>
          <div className="holders-actions">
            <input aria-label="جستجو در افزایش سهامداران" onChange={(event) => setHolderIncreaseSearch(event.target.value)} placeholder="جستجوی نماد…" type="search" value={holderIncreaseSearch} />
            <button className="primary-button" disabled={holderIncreaseLoading} onClick={() => void fetchHolderIncreases()} type="button">{holderIncreaseLoading ? "در حال دریافت…" : "بروزرسانی تغییرات"}</button>
          </div>
        </div>
        <div className="scan-scopes" role="group" aria-label="محدوده اسکن خرید حقیقی عمده">{(["haghighi", "zarbanana", "custom", "all", "market"] as HolderScope[]).map((scope) => <button key={scope} type="button" aria-pressed={increaseScope === scope} className={`source-chip ${increaseScope === scope ? "active" : ""}`} onClick={() => void fetchHolderIncreases(scope)}>اسکن {scopeLabel(scope)}{scope !== "market" ? ` (${faI.format(getScopeSymbols(scope).length)})` : ""}</button>)}</div>
        {increaseError && <p className="scan-error" role="alert">{increaseError}{holderIncreaseRows.length ? "؛ آخرین نتیجه همین محدوده نمایش داده می‌شود." : "؛ اسکن کامل نشده است."}</p>}
        <div className="holders-intro"><strong>فقط افزایش تأییدشده «شخص حقیقی» — {scopeLabel(increaseScope)}</strong><p>خریدهای عمده حقیقی در محدوده انتخاب‌شده بررسی می‌شوند. مقدار بدون تغییر، کاهش و سهامداران حقوقی وارد این جدول نمی‌شوند؛ ورود تازه فقط با مدرک رسمی خرید پذیرفته می‌شود.</p></div>
        <div className="market-stat">
          <span>تاریخ داده: <b>{holderIncreaseDate ? fmtDate(holderIncreaseDate) : "—"}</b></span>
          <span>افزایش‌های مثبت: <b>{faI.format(holderIncreaseRows.length)}</b></span>
          <span>نتیجه جستجو: <b>{faI.format(filteredHolderIncreases.length)}</b></span>
          {increaseScanned && <span className="holder-freshness warning-text" role="status">{holderFreshnessText({ sourceDate: holderIncreaseDate, fallback: holderIncreaseFallback, partial: holderIncreasePartial, delivery: holderIncreaseDelivery }, expectedDate())}</span>}
          {holderIncreasePartial && <span className="warning-text">اطلاعات تکمیلی بعضی نمادها در دسترس نبود.</span>}
        </div>
        <div className="table-wrap holder-increase-table holders-scroll"><table><thead><tr>
          <th className="rank-head">رتبه</th>
          <th>نماد</th>
          <th>تعداد سهام فعلی</th>
          <th>درصد سهام</th>
          <th>تعداد تغییر</th>
          <th>تاریخ تغییر</th>
          <th>بازار</th>
        </tr></thead>        <tbody>{holderIncreaseGroups.map((group, index) => {
          const isOpen = holderIncreasesOpen.has(group.symbol);
          // Ranking remains largest increase; every displayed parent value
          // belongs to the largest current holder (stable source-ID tie break).
          const topHolder = group.representative;
          return <Fragment key={group.id}>
          <tr className={`holder-group-row ${isOpen ? "is-open" : ""}`}>
            <td><strong className="rank-value">{faI.format(index + 1)}</strong></td>
            <td><div className="symbol-cell">
              <button className="symbol-expand-button" aria-expanded={isOpen} title={isOpen ? "بستن افراد" : "نمایش افراد"} type="button" onClick={() => toggleHolderGroup(group.symbol)}>
                <strong>{group.symbol}</strong><span className="individual-holder-tag holder-people-inline" title="تعداد سهامداران حقیقی عمده این نماد">{faI.format(group.people)} شخص حقیقی</span><span className="holder-caret" aria-hidden="true">{isOpen ? "▴" : "▾"}</span>
              </button>
              <CopySymbol symbol={group.symbol} />
              <span className="symbol-cell-sub">{group.instrumentName}</span>
            </div></td>
            <td><strong dir="ltr">{compactSharesEn(topHolder.currentShares)}</strong><small>بیشترین دارنده</small></td>
            <td><OwnershipValue row={topHolder} /></td>
            <td><strong className="share-change-positive" dir="ltr">{signedSharesEn(topHolder.changeShares)}</strong><small>تغییر همان شخص</small></td>
            <td><strong>{fmtDate(topHolder.date)}</strong></td>
            <td><span className="market-badge">{group.market}</span></td>
          </tr>
          {isOpen && group.children.map((row, childIndex) => <tr className="holder-child-row" key={row.id}>
            <td />
            <td><span className="individual-holder-tag holder-child-tag">{row.shareholderType} {faI.format(childIndex + 1)}</span></td>
            <td><strong dir="ltr">{compactSharesEn(row.currentShares)}</strong><small>{row.previousShares === null ? "قبلی: ناموجود · تغییر رسمی منبع" : `قبلی: ${row.previousCompact}`}</small></td>
            <td><OwnershipValue row={row} /></td>
            <td><strong className="share-change-positive" dir="ltr">+{row.changeCompact}</strong></td>
            <td><strong>{fmtDate(row.date)}</strong></td>
            <td><span className="market-badge">{row.market}</span></td>
          </tr>)}
          </Fragment>;
        })}
        </tbody></table>{!holderIncreaseGroups.length && <div className="empty-state">{holderIncreaseLoading ? <><span className="spinner" /> در حال دریافت دیتاست رسمی…</> : increaseError ? "دریافت ناموفق بود؛ برای تلاش دوباره بروزرسانی را بزنید." : !increaseScanned ? "یک محدوده دارای نماد را برای اسکن انتخاب کنید." : holderIncreasePartial ? "اسکن ناقص است؛ نبود ردیف به معنی نبود خرید نیست." : holderIncreaseFallback ? "در نسخه پشتیبان تاریخ‌دار، ردیفی برای این جستجو نیست؛ نتیجه امروز مشخص نیست." : "افزایش مثبتی برای این جستجو در جلسه منبع ثبت نشده است."}</div>}</div>
        <footer className="panel-foot"><span>رتبه: بیشترین افزایش فرد؛ مقادیر والد: شخص با بیشترین سهام فعلی</span><span>{holderIncreaseUpdatedAt ? `آخرین دریافت: ${faDT.format(holderIncreaseUpdatedAt)}` : "تاریخ نمایش از خود منبع خوانده می‌شود."}</span></footer>
      </section>}

      {/* ── SELECTED (منتخب) TAB ── */}
      {activeTab === "selected" && <section className="panel holders-panel">
        <div className="panel-head"><div><p className="eyebrow">واچ‌لیست شخصی</p><h2>⭐ نمادهای منتخب</h2></div></div>
        <div className="holders-intro"><strong>واچ‌لیست شما</strong><p>نمادهایی که با ⭐ ستاره‌دار کرده‌اید از هر سه فهرست (حقیقی، زرد/نارنجی، دلخواه) اینجا نمایش داده می‌شوند.</p></div>
        <div className="market-stat"><span>تعداد منتخب‌ها: <b>{faI.format(allFavRows.length)}</b></span></div>
        {favoriteLoading && <p role="status">در حال دریافت تاریخچه نمادهای منتخبِ فهرست‌های غیرفعال…</p>}
        {favoriteError && <p className="warning-text" role="alert">{favoriteError}</p>}
        {allFavRows.length > 0 && <>{renderDataTable(allFavRows)}</>}
        {!allFavRows.length && <div className="empty-state">هیچ نماد منتخبی وجود ندارد. روی ⭐ در هر فهرست کلیک کنید.</div>}
      </section>}

      {(activeTab === "3m" || activeTab === "6m" || activeTab === "selected") && sourceErrors[activeSource] && <p className="scan-error" role="alert">{sourceErrors[activeSource]}{latestDate ? ` آخرین جلسه موجود: ${fmtDate(latestDate)}.` : ""}</p>}
      <p className="data-note">قیمت و سابقه بازار از داده‌های زروان/TSETMC و تغییر تعداد سهام از TSETMC خوانده می‌شود. ابزار سیگنال خرید یا فروش نیست.</p>
    </section>

    {/* ── MODAL: Symbol Management ── */}
    {mgrOpen && <div className="modal-backdrop" role="presentation" onMouseDown={() => setMgrOpen(null)}>
      <section aria-labelledby="mgr-title" aria-modal="true" className="modal" onMouseDown={(e) => e.stopPropagation()} role="dialog">
        <div className="modal-head">
          <div><p className="eyebrow">فهرست اختصاصی من</p><h2 id="mgr-title">مدیریت نمادهای {sourceLabel(mgrOpen)}</h2></div>
          <button aria-label="بستن" className="icon-button" onClick={() => setMgrOpen(null)} type="button">×</button>
        </div>
        <p className="modal-copy">هر نماد را در یک خط بنویس یا متن چندستونه‌ی کپی‌شده را مستقیم اینجا بچسبان. برنامه عددهای اضافی را نادیده می‌گیرد، نام‌های فارسی را استخراج می‌کند، ترتیب را نگه می‌دارد و تکراری‌ها را حذف می‌کند.</p>
        <textarea aria-label="فهرست نمادها" onChange={(e) => setMgrDraft(e.target.value)} spellCheck={false} value={mgrDraft} />
        <div className="modal-stats"><span>{parseTxtSymbols(mgrDraft).length} نماد معتبر</span><span>افزودن، حذف و ذخیره روی همین مرورگر</span></div>
        <input accept=".txt,text/plain" className="visually-hidden" onChange={handleMgrFile} ref={fileInputRef} type="file" />
        <div className="modal-actions">
          <button className="secondary-button" onClick={() => fileInputRef.current?.click()} type="button">خواندن فایل TXT</button>
          <button className="secondary-button" onClick={exportMgrTxt} type="button">خروجی TXT</button>
          <button className="primary-button" onClick={saveMgr} type="button">ذخیره فهرست</button>
        </div>
      </section>
    </div>}

    {divergenceView && <DivergenceDetails row={divergenceView} onClose={() => setDivergenceView(null)} />}
    {actionView && <ActionModal actions={actionView.actions} period={actionView.period} row={actionView.row} onClose={() => setActionView(null)} />}

    {showWelcome && <div className="modal-backdrop" role="presentation" onClick={() => setShowWelcome(false)}>
      <section className="modal welcome-modal" onClick={(e) => e.stopPropagation()} role="dialog">
        <div className="welcome-content">
          <div className="welcome-brand"><span className="brand-mark welcome-mark" aria-hidden="true">ب</span></div>
          <h2 className="welcome-title">فیلتر بورس ایران</h2>
          <p className="welcome-sub">دیده‌بان شخصی بازار سرمایه</p>
          <div className="welcome-divider" />
          <button className="primary-button welcome-btn" onClick={() => setShowWelcome(false)} type="button">ورود به برنامه</button>
        </div>
      </section>
    </div>}
  </main>;
}

// ─── Action Modal ───────────────────────────────────────────────────────────
function ActionModal({ row, actions, period, onClose }: { row: ScreenerRow; actions: CorporateAction[]; period: Period; onClose: () => void }) {
  const faN = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 2 });
  const faI = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 0 });
  const faMD = new Intl.DateTimeFormat("fa-IR-u-ca-persian", { year: "numeric", month: "2-digit", day: "2-digit" });
  const fmtDate = (v: string) => { const r = String(v); if (!/^\d{8}$/.test(r)) return r; const d = new Date(Date.UTC(+r.slice(0, 4), +r.slice(4, 6) - 1, +r.slice(6, 8))); return faMD.format(d); };
  
const fp = (v: number | null | undefined) => v === null || v === undefined || Number.isNaN(v) ? "—" : faN.format(v);
  return <div className="modal-backdrop" role="presentation" onMouseDown={onClose}><section aria-labelledby="action-title" aria-modal="true" className="modal action-modal" onMouseDown={(e) => e.stopPropagation()} role="dialog">
    <div className="modal-head"><div><p className="eyebrow">رویدادهای {period === "3m" ? "۹۰ روزه" : "۱۸۰ روزه"} نماد {row.symbol}</p><h2 id="action-title">کنترل رسمی افزایش سرمایه و تعدیل</h2></div><button aria-label="بستن" className="icon-button" onClick={onClose} type="button">×</button></div>
    {row.note && <p className="modal-copy">{row.note}</p>}
    <div className="event-list">{actions.map((a, i) => <article key={`${a.date}-${i}`}><div><span className={a.confirmed ? "event-tag confirmed" : "event-tag estimated"}>{a.confirmed ? "تأیید رسمی" : "نیازمند بررسی"}</span><strong>{a.kind}</strong></div><dl className={a.confirmed ? "official-action" : ""}><div><dt>تاریخ اعمال</dt><dd>{fmtDate(a.date)}</dd></div><div><dt>قیمت قبل (ریال)</dt><dd>{fp(a.before)}</dd></div><div><dt>مبنای بعد (ریال)</dt><dd>{fp(a.after)}</dd></div><div><dt>{a.confirmed ? "درصد افزایش سهام" : "اندازه شکاف"}</dt><dd>{faN.format(a.percent)}٪</dd></div>{a.confirmed && <><div><dt>تعداد سهام قبل</dt><dd>{a.oldShares ? faI.format(a.oldShares) : "—"}</dd></div><div><dt>تعداد سهام بعد</dt><dd>{a.newShares ? faI.format(a.newShares) : "—"}</dd></div></>}</dl></article>)}</div>
  </section></div>;
}
