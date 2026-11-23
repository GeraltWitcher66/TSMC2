// Probe: inspect خودرو raw candle dates around the event window.
const sym = "خودرو";
const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(sym)}`, { headers: { Accept: "application/json" } });
const data = await res.json();
const candles = [...Object.values(data)[0]].sort((a, b) => a.d_even - b.d_even);
console.log("total candles:", candles.length);
console.log("first date:", candles[0].d_even, "last date:", candles.at(-1).d_even);
const win = candles.filter((c) => c.d_even >= 20260615 && c.d_even <= 20260715);
for (const c of win) console.log(c.d_even, "close:", c.close, "last:", c.last, "yesterday:", c.yesterday ?? "-");
