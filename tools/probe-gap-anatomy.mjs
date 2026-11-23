// Inspect the actual yesterday/close discontinuities ("gaps") in Zarvan data.
// Are they real corporate actions, or is the yesterday field unreliable?
const SYMBOLS = ["فولاد", "جم", "شبندر", "كگل", "خودرو"];
const candleMap = new Map();
for (const part of [SYMBOLS]) {
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(part.join(","))}`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    for (const [key, candles] of Object.entries(data)) if (Array.isArray(candles) && candles.length) candleMap.set(key, candles);
  } catch { /* skip */ }
}
for (const [sym, candles] of candleMap) {
  const sorted = [...candles].sort((a, b) => a.d_even - b.d_even);
  console.log(`\n=== ${sym} (${sorted.length} candles) — discontinuities >= 8% ===`);
  let count = 0;
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (!cur.yesterday || !prev.close) continue;
    const ratio = cur.yesterday / prev.close;
    if (Math.abs(ratio - 1) >= 0.08) {
      count++;
      if (count <= 8) {
        console.log(`  ${cur.d_even}: yesterday=${cur.yesterday} vs prevClose=${prev.close} ratio=${ratio.toFixed(3)} (cur close=${cur.close}, prev d_even=${prev.d_even})`);
      }
    }
  }
  console.log(`  total discontinuities: ${count}`);
}
