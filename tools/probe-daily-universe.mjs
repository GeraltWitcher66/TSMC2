// Full-universe live scan: classify ALL 674 market symbols under the new
// day-over-day divergence rule and emit the evidence rows for the report.
import { analyzeDivergence } from "../app/lib/divergence.ts";

const universeRes = await fetch("https://iran-stock-screener.ar-nikzad09.workers.dev/api/market-universe", { signal: AbortSignal.timeout(20000) });
const universe = await universeRes.json();
const symbols = (universe.symbols ?? universe).map((s) => s.symbol ?? s);
console.error("universe:", symbols.length);

const results = [];
let fetched = 0;
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
for (const part of chunk(symbols, 40)) {
  const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=260&syms=${encodeURIComponent(part.join(","))}`, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) continue;
  const payload = await res.json();
  for (const [symbol, rows] of Object.entries(payload ?? {})) {
    fetched++;
    const candles = (Array.isArray(rows) ? rows : []).map((r) => ({
      d_even: Number(r.d_even), close: Number(r.close), last: Number(r.last ?? r.close),
      high: Number(r.high ?? r.close), low: Number(r.low ?? r.close), open: Number(r.open ?? r.close),
      yesterday: Number(r.yesterday ?? 0) || 0,
    })).filter((c) => c.d_even >= 19000101 && Number.isFinite(c.close) && c.close > 0).sort((a, b) => a.d_even - b.d_even);
    if (!candles.length) continue;
    try { results.push({ symbol, analysis: analyzeDivergence(candles, [], 90) }); } catch { /* skip */ }
  }
}
console.error("fetched:", fetched);

const tally = {};
for (const r of results) tally[r.analysis.status] = (tally[r.analysis.status] ?? 0) + 1;
console.log("TALLY:", JSON.stringify(tally));

const row = (r) => r.analysis.divergence ? {
  symbol: r.symbol,
  prevDate: r.analysis.divergence.previous.date, prevClose: r.analysis.divergence.previous.close, prevRsi: r.analysis.divergence.previous.rsi,
  lastDate: r.analysis.divergence.latest.date, lastClose: r.analysis.divergence.latest.close, lastRsi: r.analysis.divergence.latest.rsi,
  price: r.analysis.divergence.priceDirection, rsi: r.analysis.divergence.rsiDirection, label: r.analysis.divergence.label,
} : { symbol: r.symbol, status: r.analysis.status };

console.log("\n=== NEGATIVE (all) ===");
for (const r of results.filter((x) => x.analysis.status === "negative")) console.log(JSON.stringify(row(r)));
console.log("\n=== POSITIVE (all) ===");
for (const r of results.filter((x) => x.analysis.status === "positive")) console.log(JSON.stringify(row(r)));
console.log("\n=== NONE (first 3) ===");
for (const r of results.filter((x) => x.analysis.status === "none").slice(0, 3)) console.log(JSON.stringify(row(r)));
console.log("\n=== OTHER STATUSES (first 3 each) ===");
for (const st of ["insufficient", "adjustment", "invalid", "stale"]) {
  const sample = results.filter((x) => x.analysis.status === st).slice(0, 3).map((r) => r.symbol);
  if (sample.length) console.log(st + ":", JSON.stringify(sample));
}
