// 1000-candle probe: does a longer history fix the "adjustment" blocker and
// does the engine detect divergences on real data?
import { analyzeDivergence, resolveAnalysisAdjustments } from "../app/lib/divergence.ts";

const SYMBOLS = [
  "جم", "حخزر", "شپنا", "فولاد", "كگل", "خودرو", "وبملت", "ذوب", "فملی", "خساپا",
  "شپدیس", "پارسان", "كرمان", "وبصادر", "بازر", "لپارس", "وشمال", "فخوز", "كچاد",
  "كحجار", "ثشدن", "حپترو", "دفرخ", "بركت", "كاروز", "پرچم", "نوری", "مفاخر",
  "كیسون", "حخزر", "ثشرق", "غگل", "شپلی", "پسهند", "مبین", "حفاری", "پشاهن",
  "بمپنا", "شبندر", "وسپهر", "وساپار", "ولتجار", "وتوس", "وصندوق", "چدن", "فجر",
  "خبهمن", "خزم", "تپکو", "غدنا", "کگهر",
];
const uniq = [...new Set(SYMBOLS)];

const candleMap = new Map();
for (let i = 0; i < uniq.length; i += 30) {
  const part = uniq.slice(i, i + 30);
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(part.join(","))}`, { headers: { Accept: "application/json" } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const [key, candles] of Object.entries(data)) if (Array.isArray(candles) && candles.length) candleMap.set(key, candles);
  } catch { /* skip batch */ }
}
console.error(`fetched ${candleMap.size} histories (1000 candles each)`);
const newest = Math.max(...[...candleMap.values()].map((cs) => Math.max(...cs.map((c) => c.d_even))));
const now = new Date(`${String(newest).slice(0, 4)}-${String(newest).slice(4, 6)}-${String(newest).slice(6, 8)}T10:30:00Z`);

const tally = { closing: {}, last: {} };
const found = { closing: [], last: [] };
for (const [sym, candles] of candleMap) {
  for (const source of ["closing", "last"]) {
    const a = analyzeDivergence(candles, [], 90, { now, priceSource: source });
    tally[source][a.status] = (tally[source][a.status] || 0) + 1;
    if (a.active) found[source].push({ sym, type: a.active.type, state: a.active.state, start: a.active.startDate, end: a.active.endDate, startPrice: a.active.startPrice, endPrice: a.active.endPrice, startRsi: a.active.startRsi, endRsi: a.active.endRsi, rsiNow: a.rsi, candleCount: a.candleCount });
  }
}
console.log("closing:", JSON.stringify(tally.closing));
console.log("last:   ", JSON.stringify(tally.last));
for (const source of ["closing", "last"]) {
  console.log(`ACTIVE [${source}]: ${found[source].length}`);
  for (const f of found[source]) console.log(`${f.sym} ${f.type}/${f.state} ${f.start}→${f.end} price ${f.startPrice}→${f.endPrice} RSI ${f.startRsi}→${f.endRsi} (candles ${f.candleCount})`);
}
