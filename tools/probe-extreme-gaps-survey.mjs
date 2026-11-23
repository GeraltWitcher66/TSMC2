// Survey the WHOLE universe for extreme overnight reference gaps.
const uni = await (await fetch("https://iran-stock-screener.ar-nikzad09.workers.dev/api/market-universe")).json();
const all = (uni.symbols ?? []).map((s) => s.symbol).filter(Boolean);
const stats = { extremeOvernight: 0, continuousClose: 0, brokenClose: 0 };
const broken = [];
for (let i = 0; i < all.length; i += 30) {
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=260&syms=${encodeURIComponent(all.slice(i, i + 30).join(","))}`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    for (const [sym, rawCandles] of Object.entries(data)) {
      if (!Array.isArray(rawCandles)) continue;
      const candles = [...rawCandles].sort((a, b) => a.d_even - b.d_even);
      for (let j = 1; j < candles.length; j++) {
        const p = candles[j - 1], c = candles[j];
        if (!c.yesterday || !p.close) continue;
        const ratio = c.yesterday / p.close;
        if (ratio >= 0.60 && ratio <= 1.50) continue;
        const gapDays = (Date.UTC(Math.floor(c.d_even / 10000), Math.floor(c.d_even / 100) % 100 - 1, c.d_even % 100) - Date.UTC(Math.floor(p.d_even / 10000), Math.floor(p.d_even / 100) % 100 - 1, p.d_even % 100)) / 86400000;
        if (gapDays > 7) continue;
        stats.extremeOvernight++;
        const closeJump = Math.abs(c.close / c.yesterday - 1);
        if (closeJump <= 0.12) stats.continuousClose++;
        else { stats.brokenClose++; if (broken.length < 15) broken.push(`${sym}@${c.d_even} ratio=${ratio.toFixed(2)} closeJump=${(closeJump * 100).toFixed(0)}%`); }
      }
    }
  } catch { /* skip batch */ }
}
console.log("SURVEY:", JSON.stringify(stats));
console.log("broken:", broken);
