// E2E acceptance: engine vs production API across five divergence classes.
import { analyzeDivergence } from "../app/lib/divergence.ts";

const CLASSES = [
  { name: "bearish-active", symbol: "پاکشو" },
  { name: "bullish-past", symbol: "کیا" },
  { name: "none", symbol: "آبین" },
  { name: "insufficient", symbol: "اتکاسا" },
  { name: "adjustment", symbol: "بنیرو" },
];

const base = "https://iran-stock-screener.ar-nikzad09.workers.dev";
const out = [];
for (const { name, symbol } of CLASSES) {
  // 1) engine on raw upstream candles
  let engine = null, candleErr = null;
  try {
    const res = await fetch(`https://zarvanfund.ir/api/daily-batch?limit=260&syms=${encodeURIComponent(symbol)}`, { headers: { Accept: "application/json" } });
    const data = await res.json();
    const candles = data[symbol] ?? Object.values(data)[0];
    if (Array.isArray(candles) && candles.length) {
      const newest = Math.max(...candles.map((c) => c.d_even));
      const now = new Date(`${String(newest).slice(0, 4)}-${String(newest).slice(4, 6)}-${String(newest).slice(6, 8)}T10:30:00Z`);
      const a = analyzeDivergence(candles, [], 90, { now });
      engine = { status: a.status, active: a.active ? `${a.active.type}/${a.active.state}` : null, event: a.active ?? a.events[0] ?? null, rsi: a.rsi };
    } else candleErr = "no candles";
  } catch (e) { candleErr = e.message; }

  // 2) production API row
  let api = null, apiErr = null;
  try {
    const res = await fetch(base + "/api/screener", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ symbols: [symbol] }) });
    const data = await res.json();
    const row = data.rows?.[0];
    api = row ? { status: row.status, divergence: row.divergence ? `${row.divergence.type}/${row.divergence.state}` : null, ev: row.divergence ?? row.divergenceAnalysis?.events?.[0] ?? null, rsi: row.rsi, note: row.note ?? null } : `no row (${res.status})`;
  } catch (e) { apiErr = e.message; }

  console.log(`\n### ${name} — ${symbol}`);
  console.log("  engine:", engine ? `status=${engine.status} active=${engine.active} rsi=${engine.rsi}` : `ERR ${candleErr}`);
  if (engine?.event) console.log(`    P1 ${engine.event.startDate} close=${engine.event.startPrice} rsi=${engine.event.startRsi} | P2 ${engine.event.endDate ?? "OPEN"} close=${engine.event.endPrice} rsi=${engine.event.endRsi}`);
  console.log("  api:   ", api && !apiErr ? `status=${api.status} divergence=${api.divergence} rsi=${api.rsi}` : `ERR ${apiErr ?? api}`);
  if (api?.ev) console.log(`    P1 ${api.ev.startDate} close=${api.ev.startPrice} rsi=${api.ev.startRsi} | P2 ${api.ev.endDate ?? "OPEN"} close=${api.ev.endPrice} rsi=${api.ev.endRsi}`);
  if (api?.note) console.log("    note:", api.note.slice(0, 70));
  out.push({ name, symbol, engine, api });
}
console.log("\nDONE", out.length);
