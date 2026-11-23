// Compare divergence detection on real candles with "closing" vs "last" price
// source, and measure the "adjustment" blocker rate. Uses the same Zarvan
// daily-batch endpoint the Worker's screener route uses.
import { analyzeDivergence } from "../app/lib/divergence.ts";
import { resolveAnalysisAdjustments } from "../app/lib/divergence.ts";

const SYMBOLS = ["كگل","شپنا","فولاد","خودرو","وبملت","ذوب","فملی","خساپا","شپدیس","پارسان","كرمان","وبصادر","جم","بازر","لپارس","وشمال","فخوز","كچاد","كحجار","ثشدن","حپترو","دفرخ","بركت","كاروز","پرچم","نوری","مفاخر","كیسون","حخزر","ثشرق","غگل","شپلی","پسهند","مبین","حفاری","پشاهن","بمپنا","شبندر","وسپهر","وساپار","ولتجار","وتوس","وصندوق","چدن","فجر","خبهمن","خزم","شپلی","غپindo","زمگس"];
const uniq = [...new Set(SYMBOLS)];

const candleMap = new Map();
for (let i = 0; i < uniq.length; i += 40) {
  const part = uniq.slice(i, i + 40);
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=260&syms=${encodeURIComponent(part.join(","))}`, { headers: { Accept: "application/json" } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const [key, candles] of Object.entries(data)) if (Array.isArray(candles) && candles.length) candleMap.set(key, candles);
  } catch { /* skip batch */ }
}
console.error(`fetched ${candleMap.size} histories`);
const newest = Math.max(...[...candleMap.values()].map((cs) => Math.max(...cs.map((c) => c.d_even))));
const now = new Date(`${String(newest).slice(0,4)}-${String(newest).slice(4,6)}-${String(newest).slice(6,8)}T10:30:00Z`);

const tally = { closing: {}, last: {} };
const foundClosing = [];
const adjDetail = [];
for (const [sym, candles] of candleMap) {
  const resolution = resolveAnalysisAdjustments(candles, []);
  if (resolution.unresolved.length) adjDetail.push({ sym, gaps: resolution.unresolved.length, dates: resolution.unresolved.slice(0, 3) });
  for (const source of ["closing", "last"]) {
    const a = analyzeDivergence(candles, [], 90, { now, priceSource: source });
    tally[source][a.status] = (tally[source][a.status] || 0) + 1;
    if (source === "closing" && a.active) foundClosing.push({ sym, ...a.active, rsiNow: a.rsi, candleCount: a.candleCount });
  }
}
console.log("adjustment-gapped symbols:", adjDetail.length, "/", candleMap.size);
adjDetail.slice(0, 8).forEach(d => console.log("  ", d.sym, "gaps:", d.gaps, d.dates.join(",")));
console.log("closing:", JSON.stringify(tally.closing));
console.log("last:   ", JSON.stringify(tally.last));
console.log("CLOSING-SOURCE ACTIVE:", foundClosing.length);
for (const f of foundClosing) console.log(`${f.sym} ${f.type}/${f.state} ${f.startDate}→${f.endDate} price ${f.startPrice}→${f.endPrice} RSI ${f.startRsi}→${f.endRsi} (candles ${f.candleCount})`);
