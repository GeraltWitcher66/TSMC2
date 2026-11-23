// Sweep real symbols for ACTIVE events (not just past events).
import { analyzeDivergence } from "../app/lib/divergence.ts";

const SYMBOLS = ["جم","حخزر","شپنا","فولاد","كگل","خودرو","وبملت","ذوب","فملی","خساپا","شپدیس","پارسان","كرمان","وبصادر","بازر","لپارس","وشمال","فخوز","كچاد","كحجار","ثشدن","حپترو","دفرخ","بركت","كاروز","پترول","شبندر","فنورد","کیسون","كگهر","چدن","كنور","تکنار","وسپهر","سشرق","فجر","ک audiences".slice(0,0)||"کمر","صنعت","وصنا","گکو","شبریز","کدال","حفاری","فولاد".slice(0,0)||"فاما","ولساپا","وبصادر".slice(0,0)||"وبشهر","کگچ","دماوند","بالاس","کفر","سپه"].filter(s=>s.length>=2);

const results = { active: [], states: {} };
for (const sym of SYMBOLS) {
  try {
    const url = `https://iran-stock-screener.ar-nikzad09.workers.dev/api/history?symbol=${encodeURIComponent(sym)}`;
    const res = await fetch(url);
    if (!res.ok) continue;
    const data = await res.json();
    const candles = data.candles ?? data.history ?? data;
    if (!Array.isArray(candles) || candles.length < 60) continue;
    const analysis = analyzeDivergence(candles, [], 90);
    if (analysis.active) {
      results.active.push({ sym, type: analysis.active.type, state: analysis.active.state, start: analysis.active.startDate, end: analysis.active.endDate });
    }
    results.states[analysis.status] = (results.states[analysis.status] ?? 0) + 1;
  } catch { /* skip */ }
}
console.log("STATUS TALLY:", results.states);
console.log("ACTIVE COUNT:", results.active.length);
for (const a of results.active) console.log(`  ${a.sym}: ${a.type} ${a.state} ${a.start}→${a.end}`);
