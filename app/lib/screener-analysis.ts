import { analyzeDivergence, calculatePeriod, calculateValuationMetrics, detectGapActions, sixMonthCutoff, subtractCalendarDays, type Candle, type ShareChange, type ScreenerRow } from "./market";
import { resolveAnalysisAdjustments } from "./divergence";
import { sourceSession } from "./market-session";

/** One calculation path for Worker data and the browser's official refresh. */
export function recalculateScreenerRow(row: ScreenerRow, candles: Candle[], changes: ShareChange[], quoteVerified: boolean, now = new Date()): ScreenerRow {
  if (!candles.length || !row.analysisInput) return row;
  const latest = Math.max(...candles.map((c) => c.d_even));
  // A safely dated closing price and a safely computed long-period return
  // have different evidentiary requirements. Never hide the former just
  // because a split or short history makes the latter unreportable.
  const latestDatedCandle = [...candles]
    .filter((c) => sourceSession(c.d_even, now) && Number.isFinite(c.close) && c.close > 0)
    .sort((a, b) => b.d_even - a.d_even)[0];
  const priceQuote = latestDatedCandle
    ? { closeRial: latestDatedCandle.close, sessionDate: latestDatedCandle.d_even } : null;
  const { effective: effectiveChanges, unresolved } = resolveAnalysisAdjustments(candles, changes);
  const actions = detectGapActions(candles, effectiveChanges, sixMonthCutoff(latest));
  const analysis = analyzeDivergence(candles, changes, 90, { now });
  // Intraday-quote freshness is independent of RSI swing divergence, which
  // requires confirmed pivots from fully closed daily candles.
  if (!quoteVerified) {
    analysis.reason = `تازگی قیمت لحظه‌ای تأیید نشد (${analysis.reason})`;
  }
  let periodBlocked = false;
  let incompleteHistory = false;
  const oldest = Math.min(...candles.map((c) => c.d_even));
  const safePeriod = (days: 30 | 60 | 90 | 180) => {
    const period = calculatePeriod(candles, days, effectiveChanges);
    // The underlying calculator may use the first *available* observation.
    // That is not a 90/180-day return if the feed has a gap around the period
    // boundary. Checking only the oldest candle is insufficient: e.g. a feed
    // with 2025 rows and then no trades until Aug 2026 would incorrectly label
    // that August close as the May 2026 starting price of a 180-day return.
    // A dated latest close remains available separately via priceQuote.
    const graceDays = days >= 90 ? 10 : 7;
    const firstAllowed = subtractCalendarDays(latest, days - graceDays);
    if (period && (oldest > firstAllowed || Number(period.startDate) > firstAllowed)) {
      incompleteHistory = true;
      return null;
    }
    if (period && unresolved.some((date) => date > Number(period.startDate) && date <= Number(period.currentDate))) {
      // A scale break with no verified corporate action is not a price return.
      periodBlocked = true;
      return null;
    }
    return period;
  };
  const three = safePeriod(90);
  const six = safePeriod(180);
  const oneMonth = safePeriod(30);
  const twoMonth = safePeriod(60);
  const input = row.analysisInput;
  const status = periodBlocked || incompleteHistory || !quoteVerified || actions.length || !["positive", "negative", "none"].includes(analysis.status) ? "warning" : "ready";
  return { ...row, priceQuote, quoteVerified, rsi: analysis.rsi === null ? null : Math.round(analysis.rsi * 100) / 100,
    three, six, actions,
    peakDrops: { "1m": oneMonth, "2m": twoMonth, "3m": three },
    divergence: analysis.divergence, divergenceAnalysis: analysis,
    // A valid dated closing price still has a valuation even if the 90-day
    // return was correctly withheld after a split or incomplete history.
    valuation: calculateValuationMetrics(three?.currentPrice ?? priceQuote?.closeRial ?? 0, input.eps, input.pe, input.sectorPe),
    analysisInput: { ...input, candles, changes }, status,
    note: status === "warning"
      ? (periodBlocked ? "بازده و افت از سقف بازه‌های درگیر با شکاف تعدیل حل‌نشده قابل محاسبه نیست. " : "")
        + (incompleteHistory ? "پوشش سابقه قیمت برای برخی بازه‌ها ناکافی است؛ بازده و افت از سقف بازه ناقص منتشر نمی‌شود. " : "")
        + (actions.length ? `${actions.length} رویداد افزایش سرمایه یا شکاف قیمتی در سابقه ثبت شده است. ` : "")
        + analysis.reason
      : undefined,
  };
}
