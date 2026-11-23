/**
 * Price swing / RSI divergence. RSI is built on adjusted closing prices,
 * whereas price swings use the matching adjusted daily high/low.
 * Every reported pivot and RSI observation belongs to a CLOSED session.
 */
export type PatternKind = "positive" | "negative";
export type PatternType = "regular" | "hidden";
export type PatternCode = "RD+" | "RD-" | "HD+" | "HD-";
export type PivotObservation = { index: number; date: number; price: number; rsi: number; rsiDate: number };
export type RsiPattern = {
  kind: PatternKind;
  type: PatternType;
  code: PatternCode;
  label: string;
  previous: PivotObservation;
  latest: PivotObservation;
  confirmationDate: number;
  barsSincePivot: number;
  trend: "up" | "down" | "reversal";
};
export type PatternBar = { date: number; high: number; low: number; close: number };
export type PatternSettings = {
  pivotLeft: number;
  pivotRight: number;
  minimumPivotSeparation: number;
  maximumPivotSeparation: number;
  maximumSignalAgeBars: number;
  minimumPriceMovePct: number;
  minimumRsiDifference: number;
  oscillatorAlignmentBars: number;
  trendPeriod: number;
};
export const PATTERN_DEFAULTS: Readonly<PatternSettings> = Object.freeze({
  pivotLeft: 2, pivotRight: 2,
  minimumPivotSeparation: 5, maximumPivotSeparation: 50,
  maximumSignalAgeBars: 18,
  minimumPriceMovePct: 0.3, minimumRsiDifference: 1,
  oscillatorAlignmentBars: 2,
  trendPeriod: 14,
});

function isPivot(values: number[], index: number, side: "high" | "low", left: number, right: number) {
  if (index < left || index + right >= values.length) return false;
  const v = values[index];
  if (!Number.isFinite(v)) return false;
  for (let offset = -left; offset <= right; offset++) {
    if (!offset) continue;
    const other = values[index + offset];
    if (!Number.isFinite(other) || (side === "low" ? other <= v : other >= v)) return false;
  }
  return true;
}

function smoothTrend(closes: number[], early: number, late: number, period: number): "up" | "down" | "unknown" {
  // Compare trailing averages AT the two pivots. No bars after the latter pivot
  // enter the trend test, so recent price cannot be used retroactively.
  if (early < period - 1 || late < period - 1) return "unknown";
  const avg = (end: number) => closes.slice(end - period + 1, end + 1).reduce((sum, price) => sum + price, 0) / period;
  const difference = (avg(late) - avg(early)) / avg(early);
  return difference > 0.002 ? "up" : difference < -0.002 ? "down" : "unknown";
}

function observation(bars: PatternBar[], rsi: (number | null)[], index: number, side: "high" | "low", alignment: number): PivotObservation | null {
  const from = Math.max(0, index - alignment), to = Math.min(rsi.length - 1, index + alignment);
  let chosen = -1;
  for (let i = from; i <= to; i++) {
    const value = rsi[i];
    if (value === null || !Number.isFinite(value)) continue;
    if (chosen === -1 || (side === "low" ? value < rsi[chosen]! : value > rsi[chosen]!)) chosen = i;
  }
  if (chosen === -1) return null;
  return { index, date: bars[index].date, price: bars[index][side], rsi: rsi[chosen]!, rsiDate: bars[chosen].date };
}

export function findRsiSwingDivergence(
  bars: PatternBar[],
  rsi: (number | null)[],
  lookbackDays: number,
  overrides: Partial<PatternSettings> = {},
): RsiPattern | null {
  const s = { ...PATTERN_DEFAULTS, ...overrides };
  if (bars.length !== rsi.length || bars.length < Math.max(s.trendPeriod + 3, 2 * s.pivotLeft + s.pivotRight + s.minimumPivotSeparation + 1)) return null;
  if (bars.some((bar, i) => !Number.isFinite(bar.close) || bar.close <= 0 ||
    !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || bar.low <= 0 || bar.high < bar.low ||
    bar.close < bar.low || bar.close > bar.high ||
    (i > 0 && bar.date <= bars[i - 1].date))) return null;

  const closes = bars.map((bar) => bar.close);
  const lastTime = Date.UTC(Math.floor(bars.at(-1)!.date / 10000), Math.floor(bars.at(-1)!.date / 100) % 100 - 1, bars.at(-1)!.date % 100);
  const matches: RsiPattern[] = [];
  for (const side of ["low", "high"] as const) {
    const prices = bars.map((bar) => bar[side]);
    const pivots: number[] = [];
    for (let i = s.pivotLeft; i < bars.length - s.pivotRight; i++) {
      if (isPivot(prices, i, side, s.pivotLeft, s.pivotRight)) pivots.push(i);
    }
    // Consider past confirmed swings, not only the first two local extrema;
    // a previous failed pairing should not hide a more recent valid setup.
    for (let j = pivots.length - 1; j > 0; j--) {
      const later = pivots[j];
      if (bars.length - 1 - later > s.maximumSignalAgeBars) break;
      const laterTime = Date.UTC(Math.floor(bars[later].date / 10000), Math.floor(bars[later].date / 100) % 100 - 1, bars[later].date % 100);
      if ((lastTime - laterTime) / 86400000 > lookbackDays) continue;
      for (let k = j - 1; k >= 0; k--) {
        const earlier = pivots[k];
        const spacing = later - earlier;
        if (spacing > s.maximumPivotSeparation) break;
        if (spacing < s.minimumPivotSeparation) continue;
        const earlierTime = Date.UTC(Math.floor(bars[earlier].date / 10000), Math.floor(bars[earlier].date / 100) % 100 - 1, bars[earlier].date % 100);
        // The lookback must contain both pivot dates: comparing an older
        // anchor would turn a long-ago swing into a recent signal.
        if ((lastTime - earlierTime) / 86400000 > lookbackDays) break;
        const previous = observation(bars, rsi, earlier, side, s.oscillatorAlignmentBars);
        const latest = observation(bars, rsi, later, side, s.oscillatorAlignmentBars);
        if (!previous || !latest) continue;
        const pMove = (latest.price - previous.price) / previous.price * 100;
        const rMove = latest.rsi - previous.rsi;
        // The nearest qualified previous swing is the comparison anchor.
        // If it fails, do not hunt farther into history for a favorable pair.
        if (Math.abs(pMove) < s.minimumPriceMovePct || Math.abs(rMove) < s.minimumRsiDifference) break;
        const trend = smoothTrend(closes, earlier, later, s.trendPeriod);
        let code: PatternCode | null = null;
        if (side === "low") {
          if (pMove < 0 && rMove > 0) code = "RD+";
          if (pMove > 0 && rMove < 0 && trend === "up") code = "HD+";
        } else {
          if (pMove > 0 && rMove < 0) code = "RD-";
          if (pMove < 0 && rMove > 0 && trend === "down") code = "HD-";
        }
        if (!code) break;
        // Once the newer confirmed swing has been broken by a subsequent
        // extreme, its pattern is invalidated until a new pivot is confirmed.
        const laterExtreme = bars.slice(later + s.pivotRight + 1);
        if (laterExtreme.some((bar) => side === "low" ? bar.low < latest.price : bar.high > latest.price)) break;
        matches.push({
          kind: code.endsWith("+") ? "positive" : "negative",
          type: code.startsWith("HD") ? "hidden" : "regular",
          code, label: `${code.startsWith("HD") ? "واگرایی مخفی" : "واگرایی معمولی"} ${code.endsWith("+") ? "مثبت" : "منفی"} (${code})`,
          previous, latest,
          confirmationDate: bars[later + s.pivotRight].date,
          barsSincePivot: bars.length - 1 - later,
          trend: code.startsWith("HD") ? (code.endsWith("+") ? "up" : "down") : "reversal",
        });
        // Use nearest meaningful earlier pivot for each recent pivot; no
        // cherry-picking a distant, more favourable swing.
        break;
      }
    }
  }
  matches.sort((a, b) => b.latest.index - a.latest.index || a.barsSincePivot - b.barsSincePivot);
  return matches[0] ?? null;
}
