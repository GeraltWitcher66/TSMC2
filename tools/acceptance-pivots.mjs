// Acceptance: exact pivot numbers for the six reported symbols.
import { analyzeDivergence } from "../app/lib/divergence.ts";

const SYMBOLS = ["پاکشو", "دارو", "دامین", "تشتاد", "کیا", "نمرینو"];

const candleMap = new Map();
for (const sym of SYMBOLS) {
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=260&syms=${encodeURIComponent(sym)}`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    const candles = data[sym] ?? Object.values(data)[0];
    if (Array.isArray(candles) && candles.length) candleMap.set(sym, candles);
    else console.error(`NO CANDLES: ${sym} -> ${JSON.stringify(data).slice(0, 120)}`);
  } catch (e) { console.error(`FETCH FAIL ${sym}: ${e.message}`); }
}

const newest = Math.max(...[...candleMap.values()].map((cs) => Math.max(...cs.map((c) => c.d_even))));
const now = new Date(`${String(newest).slice(0, 4)}-${String(newest).slice(4, 6)}-${String(newest).slice(6, 8)}T10:30:00Z`);

for (const [sym, candles] of candleMap) {
  const a = analyzeDivergence(candles, [], 90, { now });
  console.log(`\n### ${sym} — status=${a.status} RSI(last)=${a.rsi}`);
  const ev = a.active ?? a.events[0];
  if (!ev) { console.log("  no events"); continue; }
  console.log(`  event: ${ev.type} / ${ev.state} | active=${ev.active} | detected=${ev.detectedDate}`);
  console.log(`  P1: date=${ev.startDate} close=${ev.startPrice} rsi=${ev.startRsi} (rsiDate=${ev.startRsiDate})`);
  console.log(`  P2: date=${ev.endDate ?? "OPEN"} close=${ev.endPrice} rsi=${ev.endRsi} (rsiDate=${ev.endRsiDate})`);
  console.log(`  priceChange=${ev.priceChange}% rsiChange=${ev.rsiChange} | confirmLevel=${ev.confirmationLevel} invalidLevel=${ev.invalidationLevel}`);
  const p1 = Number(ev.startPrice), p2 = Number(ev.endPrice), r1 = Number(ev.startRsi), r2 = Number(ev.endRsi);
  if (ev.type === "bearish") {
    console.log(`  CHECK bearish: P2>P1 = ${p2 > p1} (${p2} > ${p1}) | RSI2<RSI1 = ${r2 < r1} (${r2} < ${r1})`);
  } else {
    console.log(`  CHECK bullish: P2<P1 = ${p2 < p1} (${p2} < ${p1}) | RSI2>RSI1 = ${r2 > r1} (${r2} > ${r1})`);
  }
}
