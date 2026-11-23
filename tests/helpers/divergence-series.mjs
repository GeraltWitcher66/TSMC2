export function divergenceSeries(bearish = false, tail = []) {
  // Independent geometry: a sharp first fall to 80, recovery to 95,
  // then a slower fall to 79. Both bottoms have several bars on each side.
  const prices = Array.from({ length: 150 }, (_, i) => 100 + 2 * Math.sin(i * Math.PI / 10));
  const add = (end, count) => { const start = prices.at(-1); for (let i = 1; i <= count; i++) prices.push(start + (end - start) * i / count); };
  add(80, 5); add(95, 6); add(79, 12); add(86, 5);
  prices.push(...tail);
  return prices.map((price, index) => {
    const last = bearish ? 200 - price : price;
    const date = new Date(Date.UTC(2026, 0, 1 + index));
    return { d_even: Number(date.toISOString().slice(0, 10).replaceAll('-', '')), close: last, last, high: last + 0.2, low: last - 0.2, open: last };
  });
}
export const asOf = (candles) => new Date(`${String(candles.at(-1).d_even).slice(0, 4)}-${String(candles.at(-1).d_even).slice(4, 6)}-${String(candles.at(-1).d_even).slice(6)}T12:00:00Z`);
