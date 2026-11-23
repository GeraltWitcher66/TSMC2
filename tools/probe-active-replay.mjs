// Replay probe: were the near-miss events ACTIVE when they were fresh?
// For each symbol with a past event, re-run the analysis with `now` fixed to a
// few days after endDate. If the event is active then, real detection works.
import { analyzeDivergence } from "../app/lib/divergence.ts";

const SYMBOLS = ["خودرو","کیسون","شبندر","فجر","وسپهر","چدن","تکنار","سشرق"];

const candleMap = new Map();
for (const sym of SYMBOLS) {
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(sym)}`, { headers: { Accept: "application/json" } });
    if (!res.ok) continue;
    const data = await res.json();
    const candles = Object.values(data)[0];
    if (Array.isArray(candles) && candles.length) candleMap.set(sym, candles);
  } catch { /* skip */ }
}
console.error(`fetched ${candleMap.size} histories`);

for (const [sym, candles] of candleMap) {
  const sorted = [...candles].sort((a, b) => a.d_even - b.d_even);
  const baseline = analyzeDivergence(sorted, [], 90);
  const fresh = baseline.events.filter((e) => !e.endDate);
  const candidates = baseline.events.length ? baseline.events : [];
  if (!candidates.length) { console.log(`${sym}: no events at all`); continue; }
  for (const ev of candidates) {
    const refDate = ev.endDate ?? ev.detectedDate;
    if (!refDate || !ev.startDate) continue;
    // Sample mid-event: a few days after start, before end (real Date math).
    const toDate = (n) => new Date(Date.UTC(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100));
    const toNum = (dt) => dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();
    const startDt = toDate(Number(ev.startDate)), endDt = toDate(Number(refDate));
    const midDays = Math.max(2, Math.round((endDt - startDt) / 86400000 / 2));
    const midDt = new Date(startDt.getTime() + midDays * 86400000);
    const midN = toNum(midDt);
    const midY = String(Math.floor(midN / 10000)).padStart(4, "0");
    const midM = String(Math.floor(midN / 100) % 100).padStart(2, "0");
    const midD = String(midN % 100).padStart(2, "0");
    const replayNow = new Date(`${midY}-${midM}-${midD}T10:30:00Z`);
    const prefix = sorted.filter((c) => c.d_even <= midN);
    const replayed = analyzeDivergence(prefix, [], 90, { now: replayNow });
    const a = replayed.active;
    console.log(`${sym} event ${ev.type}/${ev.state ?? "?"} ${ev.startDate}→${ev.endDate ?? "open"} | replay@${midN}: status=${replayed.status} active=${a ? `${a.type}/${a.state} ${a.startDate}→${a.endDate}` : "null"}`);
  }
}
