// Probe: replay خودرو mid-event with growing lookback windows to find the
// minimum window that keeps the event active.
import { analyzeDivergence } from "../app/lib/divergence.ts";

const sym = "خودرو";
const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(sym)}`, { headers: { Accept: "application/json" } });
const data = await res.json();
const candles = [...Object.values(data)[0]].sort((a, b) => a.d_even - b.d_even);

const midN = 20260630;
const prefix = candles.filter((c) => c.d_even <= midN);
const replayNow = new Date("2026-06-30T10:30:00Z");

for (const lookback of [90, 180, 365, 730]) {
  const a = analyzeDivergence(prefix, [], lookback, { now: replayNow });
  console.log(`lookback=${lookback}: status=${a.status} candles=${a.candleCount} active=${a.active ? `${a.active.type}/${a.active.state} ${a.active.startDate}→${a.active.endDate}` : "null"} events=${a.events.length}`);
  if (a.status === "none" && !a.active) console.log(`  reason: ${a.reason}`);
}
