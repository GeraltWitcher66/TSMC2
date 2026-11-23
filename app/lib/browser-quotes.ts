import { applyClientTypeToHighlight, candleFromInstrument, marketHighlightFromInstrument, mergeCandlesByDate, parseTsetmcDailyHistory, type MarketHighlight, type ScreenerRow, type ShareChange } from "./market";
import { instrumentFromClosingPrice } from "./current-quotes";
import { mapWithConcurrency } from "./data-reliability";
import { recalculateScreenerRow } from "./screener-analysis";
import { fetchWithTimeout } from "./request-lifecycle";
import { parseOfficialFloor, parseDatedClientType, enrichDatedClientType, validOfficialDatedPayload } from "./official-details";
import { relayUrl } from "./data-client";
import { lastClosedEquitySession, sourceSession } from "./market-session";
import { screenerQuoteSession } from "./screener-freshness";

const BASE = "https://cdn.tsetmc.com/api";
export const officialSessionFloor = parseOfficialFloor;
export function parseOfficialShareChanges(payload: unknown): ShareChange[] {
  const items = Array.isArray(payload) ? payload : Object.values(payload as Record<string, unknown> ?? {}).find(Array.isArray);
  return Array.isArray(items) ? items.flatMap((item) => {
    const date = Number(item.dEven ?? item.DEven ?? item.date), oldShares = Number(item.numberOfShareOld ?? item.NumberOfShareOld ?? item.oldShares), newShares = Number(item.numberOfShareNew ?? item.NumberOfShareNew ?? item.newShares);
    return date >= 19000101 && oldShares > 0 && newShares > 0 ? [{ date, oldShares, newShares }] : [];
  }) : [];
}

export function createBrowserQuoteClient(request: typeof fetch = fetch, options: { detailHedgeDelayMs?: number } = {}) {
  // Direct TSETMC first; when the browser's network cannot reach it (VPN exit
  // blocks, ISP issue), retry through the Worker's read-only relay route.
  const json = async (path: string, signal?: AbortSignal, highlightDetail = false) => {
    if (highlightDetail) {
      // A 12s blocked browser request followed by a 15s relay exceeds the
      // 25s highlights detail budget. Start relay shortly after the direct
      // request and use the first independently verified same-session record.
      const directController = new AbortController(), relayController = new AbortController();
      const abort = () => { directController.abort(signal?.reason); relayController.abort(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const read = async (url: string, ms: number, controller: AbortController) => {
        controller.signal.throwIfAborted();
        const response = await fetchWithTimeout(url, { cache: "no-store", signal: controller.signal }, ms, request);
        if (!response.ok) throw new Error(`منبع رسمی HTTP ${response.status} برگرداند.`);
        const value: unknown = await response.json();
        if (!validOfficialDatedPayload(path, value)) throw new Error("رکورد رسمی هم‌جلسه معتبر نیست.");
        return value;
      };
      let startRelay = () => {};
      const stagger = new Promise<void>(resolve => {
        startRelay = () => { clearTimeout(timer); resolve(); };
        timer = setTimeout(resolve, options.detailHedgeDelayMs ?? 2_000);
      });
      const direct = read(`${BASE}/${path}`, 12_000, directController).catch(error => {
        startRelay();
        throw error;
      });
      const relay = stagger
        .then(() => read(relayUrl(path), 19_000, relayController));
      try { return await Promise.any([direct, relay]); }
      finally {
        clearTimeout(timer);
        abort();
        signal?.removeEventListener("abort", abort);
      }
    }
    try {
      const response = await fetchWithTimeout(`${BASE}/${path}`, { cache: "no-store", signal }, 12_000, request);
      if (response.ok) return await response.json();
    } catch { /* fall through to the relay */ }
    const relayed = await fetchWithTimeout(relayUrl(path), { cache: "no-store", signal }, 15_000, request);
    if (!relayed.ok) throw new Error("منبع رسمی قیمت پاسخ نداد.");
    return relayed.json();
  };
  async function refresh(rows: ScreenerRow[], isCurrent: () => boolean = () => true, signal?: AbortSignal) {
    let consecutiveFailures = 0;
    return mapWithConcurrency(rows, 4, async (row) => {
      // An earlier official quote was verified *for its own session*, not for
      // every future session. Re-check older rows on a later user refresh.
      const previouslyDated = screenerQuoteSession(row);
      const alreadyVerifiedForCalendar = Boolean(previouslyDated && previouslyDated >= lastClosedEquitySession());
      if (!isCurrent() || consecutiveFailures >= 4 || !row.insCode || !row.analysisInput ||
          (row.quoteVerified && alreadyVerifiedForCalendar && ["positive", "negative", "none"].includes(row.divergenceAnalysis?.status ?? ""))) return row;
      try {
        const code = encodeURIComponent(row.insCode);
        const [rawQuote, rawHistory] = await Promise.allSettled([
          json(`ClosingPrice/GetClosingPriceInfo/${code}`, signal), json(`ClosingPrice/GetClosingPriceDailyList/${code}/1000`, signal),
        ]);
        if (!isCurrent()) return row;
        // The endpoint URL contains the requested instrument identity.
        // A different nonzero insCode in its payload must never be accepted
        // as this symbol's officially verified closing price.
        const quote = rawQuote.status === "fulfilled" ? instrumentFromClosingPrice(rawQuote.value, row.insCode) : null;
        const current = quote ? candleFromInstrument(quote) : null;
        const history = rawHistory.status === "fulfilled" ? parseTsetmcDailyHistory(rawHistory.value) : [];
        const newestKnown = Math.max(...row.analysisInput.candles.map((c) => c.d_even));
        // A dated current quote lifts the row to its own session. When the quote
        // endpoint is unavailable (for example right after midnight), official
        // closed-session history from the same provider may still carry a newer
        // session than the fallback feed; it is official and dated, so accept it
        // as a unit without claiming an intraday quote.
        if (!current && !(history.length && Math.max(...history.map((c) => c.d_even)) > newestKnown)) throw new Error("قیمت تاریخ‌دار رسمی دریافت نشد.");
        if (current && current.d_even < newestKnown) return row;
        consecutiveFailures = 0;
        // Replace the history as a unit when possible: mixing differently
        // adjusted providers can fabricate price/RSI pivots.
        const candles = current ? mergeCandlesByDate([current], history.length ? history : row.analysisInput.candles) : history;
        const newestUpdated = Math.max(0, ...candles.map((c) => c.d_even));
        const officialCurrentVerified = Boolean(current && current.d_even >= newestUpdated);
        let changes = row.analysisInput.changes;
        let updated = recalculateScreenerRow(row, candles, changes, officialCurrentVerified);
        if (updated.divergenceAnalysis?.status === "adjustment") {
          try { changes = parseOfficialShareChanges(await json(`Instrument/GetInstrumentShareChange/${code}`, signal)); } catch { /* explicit adjustment state remains */ }
          if (!isCurrent()) return row;
          updated = recalculateScreenerRow(row, candles, changes, officialCurrentVerified);
        }
        return updated;
      } catch { consecutiveFailures++; return row; }
    });
  }
  async function highlights(rows: MarketHighlight[], isCurrent: () => boolean = () => true, signal?: AbortSignal) {
    let failures = 0;
    return mapWithConcurrency(rows, 4, async (row) => {
      if (!isCurrent() || !row.insCode || failures >= 4) return row;
      if (row.floorVerified && row.clientTypeAvailable && row.clientTypeDate === row.sessionDate) return row;
      try {
        const code = encodeURIComponent(row.insCode);
        const quote = instrumentFromClosingPrice(await json(`ClosingPrice/GetClosingPriceInfo/${code}`, signal), row.insCode);
        if (!quote || !isCurrent()) return row;
        if (row.sessionDate && Number(quote.Date) < row.sessionDate) return row;
        let floor: number | null = null;
        let typed: Record<string, unknown> | null = null;
        await Promise.all([
          (async () => { try { floor = officialSessionFloor(await json(`MarketData/GetStaticThreshold/${code}/${quote.Date}`, signal), Number(quote.Date), row.insCode); } catch { /* Independent floor failure. */ } })(),
          (async () => { try { typed = parseDatedClientType(await json(`ClientType/GetClientTypeHistory/${code}/${quote.Date}`, signal), row.insCode, Number(quote.Date)); } catch { /* Independent ClientType failure. */ } })(),
        ]);
        if (!isCurrent()) return row;
        failures = 0;
        const fresh = marketHighlightFromInstrument({ ...quote, Symbol: row.symbol, InsCode: row.insCode, AllowedMin: floor, AllowedMinDate: floor ? quote.Date : null });
        if (!fresh) return row;
        const sameSession = row.sessionDate === fresh.sessionDate;
        const prior = sameSession ? row : { ...applyClientTypeToHighlight(row, null), netRealValue: null, buyPower: 0, realBuyValue: null, realSellValue: null, clientTypeDate: null, clientTypeFetchedAt: undefined, floorDate: null, floorFetchedAt: undefined };
        const updated = { ...prior, quoteSource: "tsetmc-current", quoteFetchedAt: new Date().toISOString(), delivery: "source", sessionDate: fresh.sessionDate, priceFirst: fresh.priceFirst, priceMin: fresh.priceMin, priceLast: fresh.priceLast, priceClose: fresh.priceClose, priceYesterday: fresh.priceYesterday,
          firstChangePct: fresh.firstChangePct, minChangePct: fresh.minChangePct, lastChangePct: fresh.lastChangePct, closeChangePct: fresh.closeChangePct, lastCloseGapPct: fresh.lastCloseGapPct,
          allowedMin: floor === null && sameSession && row.floorVerified ? row.allowedMin : fresh.allowedMin,
          floorVerified: fresh.floorVerified || (floor === null && sameSession && row.floorVerified),
          touchedSellQueue: floor === null && sameSession && row.floorVerified ? Math.abs(fresh.priceMin - row.allowedMin) < 0.5 : fresh.touchedSellQueue,
          reversalPct: fresh.reversalPct, volume: fresh.volume, value: fresh.value, volumeAvailable: fresh.volumeAvailable, valueAvailable: fresh.valueAvailable };
        return typed ? enrichDatedClientType(updated, typed) : updated;
      } catch { failures++; return row; }
    });
  }
  // Dated base prices are sufficient to request dated details. A quote failure
  // must not prevent independent ClientType/floor recovery.
  async function details(rows: MarketHighlight[], isCurrent: () => boolean = () => true, signal?: AbortSignal, onProgress?: (rows: MarketHighlight[]) => void) {
    const output = [...rows];
    let failures = 0;
    await mapWithConcurrency(rows, 2, async (row, index) => {
      // Under an outage keep probing later rows periodically, allowing recovery
      // without flooding both the direct provider and its Worker relay.
      if (failures >= 4 && index % 12 !== 0) return;
      if (!isCurrent() || signal?.aborted || !row.insCode || !sourceSession(row.sessionDate)) return;
      const date = row.sessionDate!, code = encodeURIComponent(row.insCode);
      let completed = false;
      const publish = (update: Partial<MarketHighlight>) => {
        if (!isCurrent() || signal?.aborted) return;
        completed = true;
        output[index] = { ...output[index], ...update }; onProgress?.([...output]);
      };
      await Promise.allSettled([
        (async () => {
          if (row.clientTypeAvailable && row.clientTypeDate === date && row.realBuyValue != null && row.realSellValue != null) return;
          const typed = parseDatedClientType(await json(`ClientType/GetClientTypeHistory/${code}/${date}`, signal, true), row.insCode, date);
          if (typed) publish({ ...enrichDatedClientType(output[index], typed), clientTypeFetchedAt: new Date().toISOString() });
        })(),
        (async () => {
          if (row.floorVerified) return;
          const floor = parseOfficialFloor(await json(`MarketData/GetStaticThreshold/${code}/${date}`, signal, true), date, row.insCode);
          if (floor !== null) publish({ allowedMin: floor, floorVerified: true, floorDate: date, floorFetchedAt: new Date().toISOString(), touchedSellQueue: row.priceMin > 0 && Math.abs(row.priceMin - floor) < 0.5 });
        })(),
      ]);
      if (completed) failures = 0;
      else failures++;
    });
    return output;
  }
  return { refresh, highlights, details };
}
export const browserQuotes = createBrowserQuoteClient();
