// Show the remaining >15% discontinuities in Zarvan data: real splits or glitches?
const SYMBOLS = ["فولاد", "جم", "شبندر", "كگل", "شپنا", "شپدیس", "حخزر", "وتوس"];
const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=1000&syms=${encodeURIComponent(SYMBOLS.join(","))}`, { headers: { Accept: "application/json" } });
const data = await res.json();
for (const [sym, candles] of Object.entries(data)) {
  const sorted = [...candles].sort((a, b) => a.d_even - b.d_even);
  const gaps = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1], cur = sorted[i];
    if (!cur.yesterday || !prev.close) continue;
    const ratio = cur.yesterday / prev.close;
    if (ratio < 0.85 || ratio > 1.15) gaps.push({ date: cur.d_even, ratio: +ratio.toFixed(3), prevClose: prev.close, yesterday: cur.yesterday, prevDate: prev.d_even, curClose: cur.close });
  }
  console.log(`\n${sym}: ${gaps.length} gaps >15%`);
  for (const g of gaps) console.log(`  ${g.date}: ratio=${g.ratio} yesterday=${g.yesterday} vs prevClose=${g.prevClose} (prev candle ${g.prevDate}; gap days=${Math.round((new Date(String(g.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) - new Date(String(g.prevDate).replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3'))) / 86400000)})`);
}
