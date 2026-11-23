// Check 2: expose price vs RSI pivot dates separately, with bar distances.
import { analyzeDivergence, wilderRsi, confirmedPivots } from "../app/lib/divergence.ts";
import { resolveAnalysisAdjustments } from "../app/lib/divergence.ts";

const SYMBOLS = ["پاکشو", "دارو", "دامین", "نمرینو", "تشتاد", "کیا"];

for (const sym of SYMBOLS) {
  const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=260&syms=${encodeURIComponent(sym)}`, { headers: { Accept: "application/json" } });
  const data = await res.json();
  const candles = [...(data[sym] ?? Object.values(data)[0])].sort((a, b) => a.d_even - b.d_even);
  const newest = candles.at(-1).d_even;
  const now = new Date(`${String(newest).slice(0, 4)}-${String(newest).slice(4, 6)}-${String(newest).slice(6, 8)}T10:30:00Z`);
  const a = analyzeDivergence(candles, [], 90, { now });
  const ev = a.active ?? a.events[0];
  console.log(`\n### ${sym} — status=${a.status}`);
  if (!ev) { console.log("  no events"); continue; }
  console.log(`  Price P1: ${ev.startDate} close=${ev.startPrice}`);
  console.log(`  RSI   P1: ${ev.startRsiDate} rsi=${ev.startRsi}`);
  console.log(`  Price P2: ${ev.endDate ?? "OPEN"} close=${ev.endPrice}`);
  console.log(`  RSI   P2: ${ev.endRsiDate} rsi=${ev.endRsi}`);
  // bar distances from the adjusted series the engine used
  const resolution = resolveAnalysisAdjustments(candles, []);
  const idx = (d) => candles.findIndex((c) => c.d_even === Number(d));
  const d1 = Math.abs(idx(ev.startRsiDate) - idx(ev.startDate));
  const d2 = Math.abs(idx(ev.endRsiDate) - idx(ev.endDate ?? ev.endDate));
  console.log(`  bar distance P1: ${d1} | P2: ${d2} | within alignmentBars=2: ${d1 <= 2 && d2 <= 2 ? "YES" : "NO"}`);
  console.log(`  type=${ev.type} state=${ev.state} active=${ev.active}`);
}
