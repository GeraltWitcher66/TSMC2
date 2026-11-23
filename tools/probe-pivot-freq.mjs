// Which gate eliminates every real divergence? Count candidate pivot pairs
// passing each filter in analyzeDivergence on real data.
import { confirmedPivots, wilderRsi } from "../app/lib/divergence.ts";

const SYMBOLS = ["فولاد","كگل","خودرو","وبملت","ذوب","فملی","خساپا","پارسان","كرمان","وبصادر","جم","لپارس","وشمال","فخوز","كچاد","ثشدن","حپترو","دفرخ","بركت","پرچم","نوری","مفاخر","ثشرق","غگل","شپلی","مبین","پشاهن","بمپنا","وسپهر","وساپار","ولتجار","وتوس","چدن","فجر","خبهمن","خزم","تپکو","غدنا","کگهر","نشابر"];
const uniq = [...new Set(SYMBOLS)];
const candleMap = new Map();
for (let i = 0; i < uniq.length; i += 30) {
  const part = uniq.slice(i, i + 30);
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(part.join(","))}`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    for (const [key, candles] of Object.entries(data)) if (Array.isArray(candles) && candles.length) candleMap.set(key, candles);
  } catch { /* skip */ }
}
const newest = Math.max(...[...candleMap.values()].map((cs) => Math.max(...cs.map((c) => c.d_even))));
const today = newest;
const cutoff = Date.UTC(Math.floor(today / 10000), Math.floor(today / 100) % 100 - 1, today % 100) - 90 * 86400000;

const stats = { symbols: 0, pairsConsidered: 0, failMinPivot: 0, failCutoff: 0, failSeparation: 0, failRsiMatch: 0, failDetection: 0, failPriceChange: 0, failRsiChange: 0, failBridge: 0, failRsiCross: 0, failPricePath: 0, pass: 0 };
for (const [sym, candles] of candleMap) {
  const raw = [...candles].sort((a, b) => a.d_even - b.d_even);
  if (raw.length < 120) continue;
  stats.symbols++;
  const adjusted = raw.map((c) => ({ date: c.d_even, high: c.high, low: c.low ?? c.close, close: c.close }));
  const rsi = wilderRsi(adjusted.map((c) => c.close));
  const lastIndex = adjusted.length - 1;
  for (const mode of ["low", "high"]) {
    const bullish = mode === "low", sign = bullish ? 1 : -1;
    const prices = adjusted.map((c) => c[mode]);
    const pivots = confirmedPivots(prices, 3, mode);
    const rsiPivots = confirmedPivots(rsi, 2, mode);
    const match = (p) => rsiPivots.filter((r) => Math.abs(p - r) <= 2).sort((a, b) => Math.abs(a - p) - Math.abs(b - p) || b - a)[0];
    for (let n = 1; n < pivots.length; n++) {
      const a = pivots[n - 1], b = pivots[n];
      stats.pairsConsidered++;
      if (a < 50) { stats.failMinPivot++; continue; }
      if (Date.UTC(Math.floor(adjusted[a].date / 10000), Math.floor(adjusted[a].date / 100) % 100 - 1, adjusted[a].date % 100) < cutoff) { stats.failCutoff++; continue; }
      if (b - a < 8 || b - a > 60) { stats.failSeparation++; continue; }
      const ra = match(a), rb = match(b);
      if (ra === undefined || rb === undefined || ra >= rb) { stats.failRsiMatch++; continue; }
      const detection = Math.max(b + 3, b + 4);
      if (detection > lastIndex) { stats.failDetection++; continue; }
      const priceChange = (prices[b] / prices[a] - 1) * 100, rsiChange = rsi[rb] - rsi[ra];
      if (-sign * priceChange < 0.6 || sign * rsiChange < 2) { stats.failPriceChange + (sign * rsiChange < 2 ? (stats.failRsiChange++, 0) : 0); continue; }
      const bridge = adjusted.slice(a + 1, b);
      const level = bullish ? Math.max(...bridge.map((c) => c.high)) : Math.min(...bridge.map((c) => c.low));
      if (sign * (level / prices[a] - 1) < 0.01) { stats.failBridge++; continue; }
      if (rsi.slice(ra + 1, rb).some((v, offset) => v !== null && sign * (v - (rsi[ra] + (rsi[rb] - rsi[ra]) * (offset + 1) / (rb - ra))) < -0.5)) { stats.failRsiCross++; continue; }
      if (prices.slice(a + 1, b).some((v) => sign * (v - prices[b]) < 0)) { stats.failPricePath++; continue; }
      stats.pass++;
    }
  }
}
console.log(JSON.stringify(stats, null, 2));
