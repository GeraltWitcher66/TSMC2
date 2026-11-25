/**
 * Price swing / RSI divergence, strictly per the employer definition:
 *   negative (bearish): price high is HIGHER than the previous high, but the
 *     RSI high is LOWER than the previous RSI high.
 *   positive (bullish): price low is LOWER than the previous low, but the RSI
 *     low is HIGHER than the previous RSI low.
 * No other combination is a divergence; hidden divergence does not exist.
 * RSI is built on adjusted closing prices, whereas price swings use the
 * matching adjusted daily high/low. Every reported pivot and RSI observation
 * belongs to a CLOSED session.
 */
export type PatternKind = "positive" | "negative";
export type PatternType = "regular";
export type PatternCode = "RD+" | "RD-";
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
};
export const PATTERN_DEFAULTS: Readonly<PatternSettings> = Object.freeze({
  pivotLeft: 2, pivotRight: 2,
  minimumPivotSeparation: 5, maximumPivotSeparation: 50,
  maximumSignalAgeBars: 10,
  minimumPriceMovePct: 0.3, minimumRsiDifference: 1,
  oscillatorAlignmentBars: 2,
});

/**
 * Swing pivot. The left side must be strict; the right side may touch the same
 * extreme. Price-limit days therefore form a flat top/bottom whose FIRST
 * candle is the only pivot (an equal neighbour on the left disqualifies the
 * later ones).
 */
function isPivot(values: number[], index: number, side: "high" | "low", left: number, right: number) {
  if (index < left || index + right >= values.length) return false;
  const v = values[index];
  if (!Number.isFinite(v)) return false;
  for (let offset = -left; offset <= right; offset++) {
    if (!offset) continue;
    const other = values[index + offset];
    if (!Number.isFinite(other)) return false;
    const violates = offset < 0
      ? (side === "low" ? other <= v : other >= v)
      : (side === "low" ? other < v : other > v);
    if (violates) return false;
  }
  return true;
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
  if (bars.length !== rsi.length || bars.length < 2 * s.pivotLeft + s.pivotRight + s.minimumPivotSeparation + 1) return null;
  if (bars.some((bar, i) => !Number.isFinite(bar.close) || bar.close <= 0 ||
    !Number.isFinite(bar.high) || !Number.isFinite(bar.low) || bar.low <= 0 || bar.high < bar.low ||
    bar.close < bar.low || bar.close > bar.high ||
    (i > 0 && bar.date <= bars[i - 1].date))) return null;

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
        // Exactly two definitions; anything else is not a divergence.
        let code: PatternCode | null = null;
        if (side === "low" && pMove < 0 && rMove > 0) code = "RD+";
        if (side === "high" && pMove > 0 && rMove < 0) code = "RD-";
        if (!code) break;
        // Once the newer confirmed swing has been broken by a subsequent
        // extreme, its pattern is invalidated until a new pivot is confirmed.
        const laterExtreme = bars.slice(later + s.pivotRight + 1);
        if (laterExtreme.some((bar) => side === "low" ? bar.low < latest.price : bar.high > latest.price)) break;
        matches.push({
          kind: code === "RD+" ? "positive" : "negative",
          type: "regular",
          code, label: code === "RD+" ? "واگرایی مثبت" : "واگرایی منفی",
          previous, latest,
          confirmationDate: bars[later + s.pivotRight].date,
          barsSincePivot: bars.length - 1 - later,
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
