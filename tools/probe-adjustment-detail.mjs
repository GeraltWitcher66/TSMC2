// Why does "adjustment" still block with 1000 candles? Inspect the unresolved
// gap dates and the post-gap history length for blocked symbols.
import { resolveAnalysisAdjustments } from "../app/lib/divergence.ts";

const SYMBOLS = ["جم", "حخزر", "شپنا", "فولاد", "كگل", "خودرو", "شبندر", "شپدیس", "خساپا", "مفاخر", "ولتجار", "وتوس"];
const candleMap = new Map();
for (let i = 0; i < SYMBOLS.length; i += 12) {
  const part = SYMBOLS.slice(i, i + 12);
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(part.join(","))}`, { headers: { Accept: "application/json" } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const [key, candles] of Object.entries(data)) if (Array.isArray(candles) && candles.length) candleMap.set(key, candles);
  } catch { /* skip */ }
}
console.log("symbol     candles  unresolved-gaps  first-gap-index  candles-after-gap  restart-ok(>=100)");
for (const [sym, candles] of candleMap) {
  const resolution = resolveAnalysisAdjustments(candles, []);
  const sorted = [...candles].sort((a, b) => a.d_even - b.d_even);
  const lastGap = resolution.unresolved.at(-1);
  const after = lastGap ? sorted.filter((c) => c.d_even >= lastGap).length : sorted.length;
  const firstGapIdx = lastGap ? sorted.findIndex((c) => c.d_even >= lastGap) : -1;
  const restartOk = !lastGap || after >= 100;
  console.log(sym.padEnd(10), String(candles.length).padEnd(9), String(resolution.unresolved.length).padEnd(17), String(firstGapIdx).padEnd(17), String(after).padEnd(19), restartOk);
}
