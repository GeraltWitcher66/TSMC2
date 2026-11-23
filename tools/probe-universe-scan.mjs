// Full-universe scan for divergence events (any state) on real data.
import { analyzeDivergence } from "../app/lib/divergence.ts";

const uni = await (await fetch("https://iran-stock-screener.ar-nikzad09.workers.dev/api/market-universe")).json();
const all = (uni.symbols ?? []).map((s) => s.symbol).filter(Boolean);
console.error(`universe: ${all.length} symbols`);

const candleMap = new Map();
for (let i = 0; i < all.length; i += 30) {
  const part = all.slice(i, i + 30);
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=260&syms=${encodeURIComponent(part.join(","))}`, { headers: { Accept: "application/json" } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const [key, candles] of Object.entries(data)) if (Array.isArray(candles) && candles.length) candleMap.set(key, candles);
  } catch { /* skip */ }
}
console.error(`histories: ${candleMap.size}`);

const newest = Math.max(...[...candleMap.values()].map((cs) => Math.max(...cs.map((c) => c.d_even))));
const now = new Date(`${String(newest).slice(0, 4)}-${String(newest).slice(4, 6)}-${String(newest).slice(6, 8)}T10:30:00Z`);

const tally = {};
const active = [], pastBullish = [], pastBearish = [], none = [], other = [];
for (const [sym, candles] of candleMap) {
  const a = analyzeDivergence(candles, [], 90, { now });
  tally[a.status] = (tally[a.status] || 0) + 1;
  if (a.active) active.push({ sym, ev: a.active });
  else if (a.status === "none") {
    const bull = a.events.filter((e) => e.type === "bullish");
    const bear = a.events.filter((e) => e.type === "bearish");
    if (bull.length) pastBullish.push({ sym, ev: bull[0] });
    else if (bear.length) pastBearish.push({ sym, ev: bear[0] });
    else none.push(sym);
  } else other.push({ sym, status: a.status });
}
console.log("TALLY:", JSON.stringify(tally));
console.log("ACTIVE:", active.length); active.slice(0, 10).forEach(x => console.log(`  ${x.sym} ${x.ev.type}/${x.ev.state} ${x.ev.startDate}→${x.ev.endDate ?? "open"}`));
console.log("PAST BULLISH:", pastBullish.length); pastBullish.slice(0, 8).forEach(x => console.log(`  ${x.sym} ${x.ev.type}/${x.ev.state} ${x.ev.startDate}→${x.ev.endDate ?? "open"} price ${x.ev.startPrice}→${x.ev.endPrice} RSI ${x.ev.startRsi}→${x.ev.endRsi}`));
console.log("PAST BEARISH:", pastBearish.length); pastBearish.slice(0, 8).forEach(x => console.log(`  ${x.sym} ${x.ev.type}/${x.ev.state} ${x.ev.startDate}→${x.ev.endDate ?? "open"} price ${x.ev.startPrice}→${x.ev.endPrice} RSI ${x.ev.startRsi}→${x.ev.endRsi}`));
console.log("OTHER:", JSON.stringify(tally));
const otherTally = {};
for (const o of other) otherTally[o.status] = (otherTally[o.status] || 0) + 1;
console.log("OTHER TALLY:", JSON.stringify(otherTally));
