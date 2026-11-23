// Probe: replay خودرو day-by-day across the event window (lookback=365).
import { analyzeDivergence } from "../app/lib/divergence.ts";

const sym = "خودرو";
const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(sym)}`, { headers: { Accept: "application/json" } });
const data = await res.json();
const candles = [...Object.values(data)[0]].sort((a, b) => a.d_even - b.d_even);

const toDate = (n) => new Date(Date.UTC(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100));
const toNum = (dt) => dt.getUTCFullYear() * 10000 + (dt.getUTCMonth() + 1) * 100 + dt.getUTCDate();

for (let n = 20260622; n <= 20260712; n++) {
  const dt = toDate(n);
  const dow = dt.getUTCDay();
  if (dow === 5 || dow === 6) continue; // skip Fri/Sat (Tehran weekend)
  const prefix = candles.filter((c) => c.d_even <= n);
  const replayed = analyzeDivergence(prefix, [], 365, { now: dt });
  const a = replayed.active;
  console.log(`@${n}: status=${replayed.status} candles=${prefix.length} active=${a ? `${a.type}/${a.state} ${a.startDate}→${a.endDate}` : "null"}`);
}
