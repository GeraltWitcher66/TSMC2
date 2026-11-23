// Probe: dump خودرو events across the window with lookback=365.
import { analyzeDivergence } from "../app/lib/divergence.ts";

const sym = "خودرو";
const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(sym)}`, { headers: { Accept: "application/json" } });
const data = await res.json();
const candles = [...Object.values(data)[0]].sort((a, b) => a.d_even - b.d_even);
const toDate = (n) => new Date(Date.UTC(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100));

for (let n = 20260701; n <= 20260712; n++) {
  const dt = toDate(n);
  const dow = dt.getUTCDay();
  if (dow === 5 || dow === 6) continue;
  const prefix = candles.filter((c) => c.d_even <= n);
  const a = analyzeDivergence(prefix, [], 365, { now: dt });
  console.log(`@${n} status=${a.status} events=${a.events.length}`);
  for (const ev of a.events) {
    console.log(`   ${ev.type}/${ev.state} active=${ev.active} ${ev.startDate}→${ev.endDate ?? "open"} detected=${ev.detectedDate} ended=${ev.endedDate ?? "-"} endReason=${ev.endReason ?? "-"}`);
  }
}
