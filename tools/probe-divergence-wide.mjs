// Wide real-market scan: does the engine EVER detect a divergence on real data?
import { analyzeDivergence } from "../app/lib/divergence.ts";

const SYMBOLS = [
  "جم","حخزر","شپنا","فولاد","كگل","خودرو","وبملت","ذوب","فملی","خساپا","شپدیس","پارسان","كرمان","وبصادر","بازر","لپارس","وشمال","فخوز","كچاد","كحجار","ثشدن","حپترو","دفرخ","بركت","كاروز","پرچم","نوری","مفاخر","كیسون","ثشرق","غگل","شپلی","پسهند","مبین","حفاری","پشاهن","بمپنا","شبندر","وسپهر","وساپار","ولتجار","وتوس","وصندوق","چدن","فجر","خبهمن","خزم","تپکو","غدنا","کگهر","شپترو","وهنر","کاما","تکرد","کچاد","خودرورو","وحخزر","بسویچ","رکمان","کisor","گکوثر","کسرا","نشابر","کگهر","سشرق","دمتص","وپارس","کپنس","فماک","کمیتسا","دلر","فنورد","کیسون","کگل","ک Bahman","بالبر","بپاس","فidar","وملی","بتک","کဓور","تکنار","کفرزان","فایرا","ک主板","غساهو","کگاز","تپمپو","کوسرم","فولادی","وشمال","برکس","کیدro","کهمت","کگودراز","تسهامد","کگهر","وبشهر","وپاسار","وتوس","ولتجار","وبصادر","وبملت","وبصادر","وپاسار","وحنا","وشمال","وبشهر","وبنگاه","وتعاون","وبیمه","وبصادر",
].map(s => s.trim()).filter(s => /^[\u0600-\u06FF]+$/.test(s));
const uniq = [...new Set(SYMBOLS)].slice(0, 90);

const candleMap = new Map();
for (let i = 0; i < uniq.length; i += 30) {
  const part = uniq.slice(i, i + 30);
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(part.join(","))}`, { headers: { Accept: "application/json" } });
    if (!res.ok) continue;
    const data = await res.json();
    for (const [key, candles] of Object.entries(data)) if (Array.isArray(candles) && candles.length) candleMap.set(key, candles);
  } catch { /* skip */ }
}
console.error(`fetched ${candleMap.size} histories`);
const newest = Math.max(...[...candleMap.values()].map((cs) => Math.max(...cs.map((c) => c.d_even))));
const now = new Date(`${String(newest).slice(0, 4)}-${String(newest).slice(4, 6)}-${String(newest).slice(6, 8)}T10:30:00Z`);

const tally = {};
const found = [];
const nearMiss = [];
for (const [sym, candles] of candleMap) {
  const a = analyzeDivergence(candles, [], 90, { now });
  tally[a.status] = (tally[a.status] || 0) + 1;
  if (a.active) found.push({ sym, ...a.active });
  else if (a.status === "none" && a.events.length) nearMiss.push({ sym, events: a.events.length, reason: a.reason });
}
console.log("TALLY:", JSON.stringify(tally));
console.log("ACTIVE:", found.length);
for (const f of found) console.log(`${f.sym} ${f.type}/${f.state} ${f.startDate}→${f.endDate} price ${f.startPrice}→${f.endPrice} RSI ${f.startRsi}→${f.endRsi} detected ${f.detectedDate}`);
console.log("Near-miss (past events, now inactive):", nearMiss.length);
nearMiss.slice(0, 10).forEach(n => console.log(`  ${n.sym}: ${n.events} past events — ${n.reason.slice(0, 60)}`));
