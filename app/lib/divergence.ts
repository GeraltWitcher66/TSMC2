import type { Candle, ShareChange } from "./market";
import { findRsiSwingDivergence, PATTERN_DEFAULTS, type RsiPattern } from "./divergence-patterns";

/**
 * Confirmed swing divergence uses two comparable price highs/lows and RSI(12)
 * computed from the adjusted CLOSE at corresponding swing dates. It can detect
 * regular (reversal warning) and hidden (trend continuation warning) patterns.
 * Day-over-day changes are NOT interpreted as technical divergence.
 * The separate screener RSI column still uses adjusted LAST-trade prices for
 * backward compatibility; it is intentionally not the divergence oscillator.
 */
export const DIVERGENCE_DEFAULTS = Object.freeze({
  rsiPeriod: 12,
  /** Minimum closed sessions required before the engine analyses a symbol. */
  minimumHistory: 24,
  maxDataAgeDays: 7,
  ...PATTERN_DEFAULTS,
});
export type DivergenceOptions = Partial<typeof DIVERGENCE_DEFAULTS> & { now?: Date };

export type DivergenceDirection = "up" | "down" | "flat";
export type DivergenceSession = { date: number; price: number; rsi: number; rsiDate: number };
export type DayOverDayDivergence = {
  kind: "positive" | "negative";
  priceDirection: DivergenceDirection;
  rsiDirection: DivergenceDirection;
  previous: DivergenceSession;
  latest: DivergenceSession;
  label: string;
  reason: string;
  type: RsiPattern["type"];
  code: RsiPattern["code"];
  confirmationDate: number;
  barsSincePivot: number;
  priceBasis: "high" | "low";
};
export type DivergenceAnalysis = {
  version: "4";
  status: "positive" | "negative" | "none" | "insufficient" | "stale" | "unverified" | "adjustment" | "invalid";
  reason: string;
  asOfDate: number | null;
  previousDate: number | null;
  rsi: number | null;
  /** RSI(12) on adjusted closes, used exclusively for swing divergence. */
  divergenceRsi: number | null;
  candleCount: number;
  /** Two confirmed swing extrema; null unless positive/negative. */
  divergence: DayOverDayDivergence | null;
};

const round = (v: number) => Math.round(v * 10000) / 10000;
const dateTime = (d: number) => Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100);
const dateNumber = (d: Date) => d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
const validDate = (d: number) => Number.isInteger(d) && d >= 19000101 && d <= 29991231 && dateNumber(new Date(dateTime(d))) === d;

/** Wilder SMA seed + recursive RMA; unrounded values remain aligned to bars. */
export function wilderRsi(values: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = values.map(() => null);
  if (values.length <= period || values.some((v) => !Number.isFinite(v) || v <= 0)) return result;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) { gain += Math.max(values[i] - values[i - 1], 0); loss += Math.max(values[i - 1] - values[i], 0); }
  gain /= period; loss /= period;
  const value = () => loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  result[period] = value();
  for (let i = period + 1; i < values.length; i++) {
    gain = (gain * (period - 1) + Math.max(values[i] - values[i - 1], 0)) / period;
    loss = (loss * (period - 1) + Math.max(values[i - 1] - values[i], 0)) / period;
    result[i] = value();
  }
  return result;
}

/**
 * Discontinuities within this ratio band are treated as provider artifacts, not
 * corporate actions. Tehran's daily price limits are ±5% (base market ±2%);
 * with a next-day range of ±10% the largest legitimate limit-to-limit reference
 * step is ≈1.05×1.10 ≈ 1.155. Additionally, the reference price (`yesterday`)
 * is itself computed from the last day's weighted average, so two consecutive
 * limit days can legitimately differ from the older close by more than the
 * naive band. The ruling principle for anything OUTSIDE that band:
 *
 *   UNKNOWN EXTREME DISCONTINUITY ⇒ DO NOT CONTAMINATE RSI.
 *
 * The only affirmative evidences that a discontinuity is NOT a corporate
 * action are:
 *   1. an official share-change record matching the gap (ground truth), or
 *   2. the first listing candle: it has no earlier observation to compare.
 *      A missing reference price cannot prove a corporate action; a large
 *      observed close-to-close break must still be marked unresolved, or
 *   3. the CLOSE series itself is continuous across the gap
 *      (|close[i]/close[i−1]−1| ≤ 16%: consecutive limit moves). RSI is
 *      computed on closes only, so a broken `yesterday` field alongside a
 *      continuous close series mathematically cannot contaminate the
 *      oscillator — that is the Zarvan provider-artifact shape.
 * Everything else — including a genuine overnight capital increase with no
 * official data, no calendar break and a close far from the new reference —
 * blocks as `unresolved` (status `adjustment`) until positive evidence
 * exists. Calendar shape and close/reference proximity are NOT evidence.
 * When official data matches, the adjustment is applied regardless of the
 * gap's calendar shape: the official record is the ground truth.
 */
const MAX_REAL_SPLIT_RATIO = 0.60;
const MIN_REAL_INCREASE_RATIO = 1.50;
/** Largest close-to-close move of consecutive ordinary limit sessions
 * (≈1.05 × 1.10). Beyond this, a reference gap cannot be ignored safely. */
const CONTINUOUS_CLOSE_MOVE = 0.16;
/** Maximum acceptable distance between an official change's registration date
 * and the observed reference gap it may explain. Registration precedes the
 * ex-rights session by up to a couple of weeks (record date → ex date), but a
 * change registered more than 45 days BEFORE the gap describes an adjustment
 * that must already be reflected in prices — matching it to a NEW gap would
 * corrupt the scale of everything between the two dates. */
const MAX_CHANGE_DISTANCE_DAYS = 45;

/** Registration date is not necessarily the first ex-rights trading date.
 * A share ratio is applied only at an observed, matching price discontinuity.
 * Do not infer a split/dividend adjustment from an arbitrary price drop. */
export function resolveAnalysisAdjustments(candles: Candle[], changes: ShareChange[]) {
  const raw = [...candles].sort((a, b) => a.d_even - b.d_even);
  const used = new Set<number>();
  const effective: ShareChange[] = [];
  const unresolved: number[] = [];
  for (let i = 1; i < raw.length; i++) {
    const previous = raw[i - 1], current = raw[i];
    if (!Number.isFinite(previous.close) || previous.close <= 0 || !Number.isFinite(current.close) || current.close <= 0) continue;
    const hasReference = Number.isFinite(current.yesterday) && current.yesterday! > 0;
    // For an absent reference, the observed close discontinuity is sufficient
    // to flag unsafe data, but does not establish that a share change occurred.
    const ratio = (hasReference ? current.yesterday! : current.close) / previous.close;
    const extreme = ratio < MAX_REAL_SPLIT_RATIO || ratio > MIN_REAL_INCREASE_RATIO;
    const continuousCloses = Math.abs(current.close / previous.close - 1) <= CONTINUOUS_CLOSE_MOVE;
    const missingReferenceJump = !hasReference && !continuousCloses;
    // Official events may be moderate (<40% reference move): they must be
    // matched before the extreme-gap guard decides whether to skip this date.
    if (!extreme && !missingReferenceJump && !changes.length) continue;
    // The first candle has no predecessor and never enters this loop. The
    // second candle must still be examined for a real corporate-action gap.
    // Affirmative evidence 3: the close series itself is continuous. RSI runs
    // on closes only, so a broken reference field next to a continuous close
    // chain cannot contaminate the oscillator (Zarvan artifact shape).
    // Official share data is the ground truth: try to match first, regardless
    // of the gap's calendar shape. Closest effective date wins, and a change
    // registered more than MAX_CHANGE_DISTANCE_DAYS before the gap can never
    // explain it — its effect must already be inside the price series.
    const matches = changes.map((change, index) => ({ change, index }))
      .filter(({ change, index }) => !used.has(index) && change.oldShares > 0 && change.newShares > 0
        && validDate(change.date)
        && dateTime(change.date) <= dateTime(current.d_even)
        && dateTime(current.d_even) - dateTime(change.date) <= MAX_CHANGE_DISTANCE_DAYS * 86400000
        // The provider's `yesterday` is the previous day's weighted average,
        // not the theoretical adjusted reference, so the observed ratio can
        // deviate from the official share ratio by a few percent. Direction
        // and magnitude must still agree. Narrow the tolerance for small
        // official actions to avoid consuming ordinary price movement as a
        // capital increase; retain the historical 15% cap for large splits.
        && Math.abs(ratio / (change.oldShares / change.newShares) - 1) <=
          Math.min(0.15, Math.abs(1 - change.oldShares / change.newShares) * 0.35))
      .sort((a, b) => dateTime(b.change.date) - dateTime(a.change.date));
    if (matches.length) { used.add(matches[0].index); effective.push({ ...matches[0].change, date: current.d_even }); continue; }
    if (!extreme && !missingReferenceJump) continue;
    if (continuousCloses) continue;
    // Two isolated observations without yesterday or official share data
    // cannot distinguish a broken vendor record from a lasting scale break.
    // Such a short series is already coverage-warning-only in the screener.
    // With at least three observations, retain the safety guard for F4.
    if (missingReferenceJump && raw.length === 2 && !changes.length) continue;
    // Reference-less feeds may contain a one-day spike followed immediately by
    // a return to the prior scale. The second (rebound) observation is not an
    // independent split; the earlier spike has already been examined above.
    if (missingReferenceJump && i >= 2 && Number.isFinite(raw[i - 2].close) && raw[i - 2].close > 0 &&
        Math.abs(current.close / raw[i - 2].close - 1) <= CONTINUOUS_CLOSE_MOVE) continue;
    unresolved.push(current.d_even);
  }
  return { effective, unresolved };
}

/** Tehran clock: a candle dated today counts as closed only after 13:00. */
function tehranMarketClock(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const clock = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return { today: Number(`${clock.year}${clock.month}${clock.day}`), hour: Number(clock.hour) };
}

const direction = (from: number, to: number): DivergenceDirection => to > from ? "up" : to < from ? "down" : "flat";

/** Legacy day-over-day comparison: diagnostic only, never used for detection. */
export function classifyDailyDivergence(previousClose: number, latestClose: number, previousRsi: number, latestRsi: number) {
  if (![previousClose, latestClose, previousRsi, latestRsi].every(Number.isFinite) || previousClose <= 0 || latestClose <= 0 ||
    previousRsi < 0 || previousRsi > 100 || latestRsi < 0 || latestRsi > 100) return "invalid" as const;
  if (latestClose > previousClose && latestRsi < previousRsi) return "negative" as const;
  if (latestClose < previousClose && latestRsi > previousRsi) return "positive" as const;
  return "none" as const;
}

/**
 * Price pivot confirmation requires bars to its right; the latest (open)
 * candle is excluded. Corporate-action guards and freshness are preserved.
 */
export function analyzeDivergence(candles: Candle[], changes: ShareChange[] = [], lookbackDays = 90, options: DivergenceOptions = {}): DivergenceAnalysis {
  const config = { ...DIVERGENCE_DEFAULTS, ...options };
  const now = options.now ?? new Date();
  const clock = tehranMarketClock(now);
  const base: DivergenceAnalysis = {
    version: "4", status: "none", reason: "در پیوت‌های تأییدشده اخیر واگرایی معمولی یا مخفی معتبر پیدا نشد.",
    asOfDate: null, previousDate: null, rsi: null, divergenceRsi: null, candleCount: 0, divergence: null,
  };
  const stop = (status: DivergenceAnalysis["status"], reason: string) => ({ ...base, status, reason });

  // 1) Deduplicate by date, drop unclosed candles, reject invalid values.
  const byDate = new Map<number, Candle>();
  for (const c of candles) {
    if (!validDate(c.d_even)) return stop("invalid", "تاریخ نامعتبر در سابقه؛ تحلیل متوقف شد.");
    if (c.d_even > clock.today || (c.d_even === clock.today && clock.hour < 13)) continue; // unfinished/live candle never used
    if (!Number.isFinite(c.close) || c.close <= 0) return stop("invalid", "قیمت پایانی نامعتبر در سابقه؛ تحلیل متوقف شد.");
    const old = byDate.get(c.d_even);
    if (old && (old.close !== c.close || (Number.isFinite(old.last) && Number.isFinite(c.last) && old.last !== c.last)))
      return stop("invalid", "دو قیمت متناقض برای یک تاریخ؛ تحلیل متوقف شد.");
    byDate.set(c.d_even, old && Number.isFinite(old.last) && !(Number.isFinite(c.last) && c.last! > 0) ? old : c);
  }
  let raw = [...byDate.values()].sort((a, b) => a.d_even - b.d_even);

  // 2) Corporate-action protection (data quality only): official ratios are
  //    applied; unresolved extreme gaps stop RSI until enough clean history.
  const resolution = resolveAnalysisAdjustments(raw, changes);
  const lastUnresolved = resolution.unresolved.at(-1);
  if (lastUnresolved) {
    const after = raw.filter((c) => c.d_even >= lastUnresolved);
    if (after.length > config.rsiPeriod) raw = after;
    else return stop("adjustment", "افزایش سرمایه بدون داده رسمی؛ برای ادامه تحلیل، تاریخ افزایش سرمایه را ثبت کنید.");
  }
  base.candleCount = raw.length;
  base.asOfDate = raw.at(-1)?.d_even ?? null;
  if (raw.length <= config.rsiPeriod) return stop("insufficient", `برای محاسبه RSI(۱۲) حداقل ${config.rsiPeriod + 1} جلسه معتبر لازم است.`);

  // The historical screener RSI uses last-trade (do not silently change it).
  // Divergence itself uses RSI of the SAME adjusted closing-price series as
  // price pivots. Both series are reported distinctly in the explanation.
  const adjusted = raw.map((c) => {
    const factor = resolution.effective.filter((a) => a.date > c.d_even).reduce((f, a) => f * a.oldShares / a.newShares, 1);
    return {
      date: c.d_even, close: c.close * factor,
      high: (Number.isFinite(c.high) && c.high > 0 ? c.high : NaN) * factor,
      low: (Number.isFinite(c.low) && c.low! > 0 ? c.low! : NaN) * factor,
      last: (Number.isFinite(c.last) && c.last! > 0 ? c.last! : c.close) * factor,
    };
  });
  const tableRsi = wilderRsi(adjusted.map((c) => c.last), config.rsiPeriod);
  const patternRsi = wilderRsi(adjusted.map((c) => c.close), config.rsiPeriod);
  const latestTableRsi = tableRsi.at(-1), latestPatternRsi = patternRsi.at(-1);
  base.rsi = latestTableRsi === null || latestTableRsi === undefined ? null : round(latestTableRsi);
  base.divergenceRsi = latestPatternRsi === null || latestPatternRsi === undefined ? null : round(latestPatternRsi);
  if (raw.length < config.minimumHistory)
    return stop("insufficient", `RSI جدول آماده است، اما برای یافتن دو پیوت واگرایی حداقل ${config.minimumHistory} جلسه معتبر لازم است.`);

  if ((dateTime(clock.today) - dateTime(base.asOfDate!)) / 86400000 > config.maxDataAgeDays) {
    return stop("stale", "آخرین جلسه بیش از هفت روز تقویمی فاصله دارد؛ واگرایی اعلام نمی‌شود.");
  }

  if (adjusted.some((c) => !Number.isFinite(c.high) || !Number.isFinite(c.low) ||
    c.low <= 0 || c.high < c.low || c.close < c.low || c.close > c.high))
    return stop("unverified", "سقف یا کف قیمت در بخشی از تاریخچه قابل تأیید نیست؛ الگوی واگرایی صادر نشد.");
  if (latestPatternRsi === null || latestPatternRsi === undefined)
    return stop("insufficient", "سابقه قیمت پایانی برای RSI کافی نیست.");

  const found = findRsiSwingDivergence(adjusted, patternRsi, lookbackDays, config);
  if (!found) {
    return { ...base, status: "none", reason: "بین دو سقف یا دو کف تأییدشده اخیر، اختلاف معتبر قیمت و RSI پیدا نشد؛ تغییر روزانه به‌تنهایی واگرایی محسوب نمی‌شود." };
  }
  const previous: DivergenceSession = { date: found.previous.date, price: round(found.previous.price), rsi: round(found.previous.rsi), rsiDate: found.previous.rsiDate };
  const latest: DivergenceSession = { date: found.latest.date, price: round(found.latest.price), rsi: round(found.latest.rsi), rsiDate: found.latest.rsiDate };
  base.previousDate = previous.date;
  const priceDirection = direction(found.previous.price, found.latest.price);
  const rsiDirection = direction(found.previous.rsi, found.latest.rsi);
  const reason = `${found.label}: دو ${found.kind === "positive" ? "کف" : "سقف"} قیمت با RSI(۱۲) قیمت پایانیِ همان محدوده‌ها ناسازگارند. پیوت دوم در ${found.confirmationDate} تأیید شده است؛ این الگو هشدار است و برگشت/ادامه روند را تضمین نمی‌کند.`;
  return {
    ...base, status: found.kind, reason,
    divergence: {
      kind: found.kind, type: found.type, code: found.code, label: found.label, reason,
      priceDirection, rsiDirection, previous, latest,
      confirmationDate: found.confirmationDate, barsSincePivot: found.barsSincePivot,
      priceBasis: found.kind === "positive" ? "low" : "high",
    },
  };
}

/** Back-compat facade used by screener rows: the classification itself. */
export function detectDivergence(candles: Candle[], changes: ShareChange[] = [], _lookbackDays = 90, options: DivergenceOptions = {}) {
  return analyzeDivergence(candles, changes, _lookbackDays, options).divergence;
}
