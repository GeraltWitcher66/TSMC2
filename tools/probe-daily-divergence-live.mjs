// Live-market evidence for the NEW day-over-day divergence spec.
// Scans real Zarvan candles; classification = latest two closed sessions,
// close direction vs RSI(12) direction (RSI built on the last-trade series).
import { analyzeDivergence } from "../app/lib/divergence.ts";

const SYMBOLS = ["جم","حخزر","شپنا","فولاد","كگل","خودرو","وبملت","ذوب","فملی","خساپا","شپدیس","پارسان","كرمان","وبصادر","بازر","لپارس","وشمال","فخوز","كچاد","كحجار","ثشدن","حپترو","دفرخ","بركت","كاروز","پردیس","وسينا","غچين","شکنار","فافزا","پشاهن","دتهران","حفاری","کيميا","قشير","کگهر","سپ珂","شبندر","فجر","وسپهر","چدن","تکنار","سشرق","کیسون","آسيا","غسازان","پلاک","مارون","نورو","نمرینو","پاکشو","دارو","سامان","دامین","تشتاد","کیا","ابو","کسرام","بنيرو","اتکاسا","ولماريخ","بپاس","وپاسار","کمنگنز","زر","خContentLoaded".slice(0,0)+"کرمانشاه".replace(" ","")||"کرمانشاه","واحصا","کگلپار","ونوين","سرچشمه","کگل","بنیرو","وبشهر","ونت","وحافظ","وصنايت","کاما","بکام","کاما٢","شتوکا","کفپارس","پارت بين".replace(" ",""),"کیمیا","پارسان"];

const unique = [...new Set(SYMBOLS.map((s) => s.trim()).filter((s) => /^[\u0600-\u06FF]+$/.test(s) && s.length >= 2 && s.length <= 12))];
const results = [];
const failures = [];

async function fetchCandles(symbol) {
  const res = await fetch(`https://zarvanfund.ir/api/daily?symbol=${encodeURIComponent(symbol)}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

await Promise.all(unique.map(async (symbol) => {
  try {
    const payload = await fetchCandles(symbol);
    const rows = Array.isArray(payload) ? payload : payload?.candles ?? payload?.list ?? payload?.data ?? [];
    const candles = (rows ?? []).map((r) => ({
      d_even: Number(r.d_even ?? r.dEven ?? r.date),
      close: Number(r.close ?? r.pClosing),
      last: Number(r.last ?? r.pDrCotVal ?? r.close),
      high: Number(r.high ?? r.priceMax ?? r.close),
      low: Number(r.low ?? r.priceMin ?? r.close),
      open: Number(r.open ?? r.priceFirst ?? r.close),
      yesterday: Number(r.yesterday ?? r.priceYesterday ?? 0) || 0,
    })).filter((c) => c.d_even >= 19000101 && Number.isFinite(c.close) && c.close > 0);
    if (candles.length < 20) { failures.push([symbol, `candles=${candles.length}`]); return; }
    const analysis = analyzeDivergence(candles, [], 90);
    results.push({ symbol, status: analysis.status, candleCount: analysis.candleCount, div: analysis.divergence });
  } catch (e) { failures.push([symbol, e.message ?? String(e)]); }
}));

const tally = {};
for (const r of results) tally[r.status] = (tally[r.status] ?? 0) + 1;
console.log("TOTAL:", results.length, "TALLY:", JSON.stringify(tally), "FAILURES:", failures.length);

const show = (status, count) => results.filter((r) => r.status === status).slice(0, count).map((r) => ({
  symbol: r.symbol,
  prev: r.div ? `${r.div.previous.date} close=${r.div.previous.close} rsi12=${r.div.previous.rsi}` : "—",
  last: r.div ? `${r.div.latest.date} close=${r.div.latest.close} rsi12=${r.div.latest.rsi}` : `(${r.status})`,
  rule: r.div ? `price ${r.div.priceDirection} & rsi ${r.div.rsiDirection} → ${r.div.label}` : "—",
}));
console.log("\nNEGATIVE (price↑ & RSI↓):");
for (const row of show("negative", 5)) console.log(JSON.stringify(row));
console.log("\nPOSITIVE (price↓ & RSI↑):");
for (const row of show("positive", 5)) console.log(JSON.stringify(row));
console.log("\nNONE (sample):");
for (const row of show("none", 5)) console.log(JSON.stringify(row));
console.log("\nINSUFFICIENT / ADJUSTMENT / INVALID / STALE (sample):");
for (const row of show("insufficient", 2)) console.log(JSON.stringify(row));
for (const row of show("adjustment", 2)) console.log(JSON.stringify(row));
for (const row of show("invalid", 2)) console.log(JSON.stringify(row));
for (const row of show("stale", 2)) console.log(JSON.stringify(row));
if (failures.length) console.log("\nFETCH FAILURES:", failures.slice(0, 10));
