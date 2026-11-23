// Real-market divergence probe: pulls real daily candles (Zarvan daily-batch,
// the Worker's primary source) and runs analyzeDivergence directly, bypassing
// the quote-verification gate, to measure whether the engine itself detects
// divergences on real data.
import { analyzeDivergence } from "../app/lib/divergence.ts";

const SYMBOLS = [
  "كگل", "شپنا", "فولاد", "خودرو", "وبملت", "ذوب", "فملی", "خساپا", "شپدیس",
  "پارسان", "كرمان", "وبصادر", "جم", "بازر", "لپارس", "وشمال", "فخوز", "كچاد",
  "فولاد", "پترول", "شپنا", "كگل", "كحجار", "ثشدن", "حپترو", "دفرخ", "بركت",
  "وبصادر", "كاروز", "پرچم", "نوری", "مفاخر", "كیسون", "حخزر", "ثشرق", "غگل",
  "شپلی", "پسهند", "مبین", "ramid", "حفاری", "پشاهن", "بمپنا", "شبندر", "وسپهر",
].map((s, i, a) => a.indexOf(s) === i ? s : null).filter(Boolean);

const batches = [];
for (let i = 0; i < SYMBOLS.length; i += 40) batches.push(SYMBOLS.slice(i, i + 40));

const candleMap = new Map();
for (const part of batches) {
  const url = `https://zarvanfund.ir/api/daily-batch?limit=260&syms=${encodeURIComponent(part.join(","))}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) { console.error("batch failed", res.status); continue; }
  const data = await res.json();
  for (const [key, candles] of Object.entries(data)) {
    if (Array.isArray(candles) && candles.length) candleMap.set(key, candles);
  }
}
console.error(`fetched ${candleMap.size} symbol histories`);

// Tehran "now": use the newest candle date at 14:00 Tehran so every candle is closed.
const newest = Math.max(...[...candleMap.values()].map((cs) => Math.max(...cs.map((c) => c.d_even))));
const now = new Date(`${String(newest).slice(0,4)}-${String(newest).slice(4,6)}-${String(newest).slice(6,8)}T10:30:00Z`);

const tally = {};
const found = [];
for (const [sym, candles] of candleMap) {
  const analysis = analyzeDivergence(candles, [], 90, { now });
  tally[analysis.status] = (tally[analysis.status] || 0) + 1;
  if (analysis.active) {
    found.push({ sym, type: analysis.active.type, state: analysis.active.state,
      start: analysis.active.startDate, end: analysis.active.endDate,
      startPrice: analysis.active.startPrice, endPrice: analysis.active.endPrice,
      startRsi: analysis.active.startRsi, endRsi: analysis.active.endRsi,
      rsiNow: analysis.rsi, candles: candles.length });
  }
}
console.log("TALLY:", JSON.stringify(tally));
console.log(`ACTIVE DIVERGENCES: ${found.length}`);
for (const f of found) {
  console.log(`${f.sym} ${f.type}/${f.state} pivots ${f.start}→${f.end} price ${f.startPrice}→${f.endPrice} RSI ${f.startRsi}→${f.endRsi} (now ${f.rsiNow}, ${f.candles} candles)`);
}
