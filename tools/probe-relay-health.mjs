// One-off health probe for the stale-prices investigation (2026-09-10).
// 1) Does Zarvan publish the 20260909 session yet?
// 2) Is TSETMC reachable from this machine (curl-equivalent)?
// 3) Burst-test the production relay: what fraction of attempts succeed?
import { writeFileSync } from "node:fs";

const INS = "35425587644337450"; // کفپارس insCode used by prior probes
const KESARAM = "20560887114747719"; // کسرام
const RELAY = "https://iran-stock-screener.ar-nikzad09.workers.dev/api/tsetmc-relay";
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36" };
const out = { at: new Date().toISOString(), zarvan: {}, tsetmcLocal: {}, relayBurst: {} };

// --- 1) Zarvan instruments for a couple of symbols ---
for (const sym of ["كسرام", "كفپارس"]) {
  try {
    const r = await fetch(`https://zarvanfund.ir/api/instruments?syms=${encodeURIComponent(sym)}`, { headers: UA, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const arr = Array.isArray(j) ? j : (j?.data ?? j?.instruments ?? []);
    const first = arr[0] ?? null;
    out.zarvan[sym] = {
      status: r.status,
      latest: first ? { date: first.dEven ?? first.date ?? null, close: first.pClosing ?? first.close ?? null } : null,
      keys: first ? Object.keys(first).slice(0, 24) : [],
    };
  } catch (e) {
    out.zarvan[sym] = { error: String(e?.message ?? e) };
  }
}

// --- 2) TSETMC direct from this machine ---
for (const [name, url] of [
  ["cdn-closingprice", `https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceInfo/${INS}`],
  ["cdn-dailylist", `https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceDailyList/${INS}/5`],
  ["apex-closingprice", `https://apex.sahandbroker.com/api/ClosingPrice/GetClosingPriceInfo/${INS}`],
]) {
  try {
    const r = await fetch(url, { headers: { ...UA, Accept: "application/json", Referer: "https://tsetmc.com/" }, signal: AbortSignal.timeout(8000) });
    let newest = null;
    if (r.ok) {
      const t = await r.text();
      try {
        const j = JSON.parse(t);
        const d = j?.closingPriceDaily ?? j?.daily ?? j;
        if (Array.isArray(d) && d.length) newest = d[d.length - 1]?.dEven ?? d[d.length - 1]?.dEven;
        else if (j?.dEven != null) newest = j.dEven;
      } catch { /* non-JSON */ }
    }
    out.tsetmcLocal[name] = { status: r.status, newest };
  } catch (e) {
    out.tsetmcLocal[name] = { error: String(e?.message ?? e) };
  }
}

// --- 3) Production relay burst: 10 sequential + 5 parallel ---
const relayPath = `?path=${encodeURIComponent(`ClosingPrice/GetClosingPriceInfo/${INS}`)}`;
const burst = [];
for (let i = 0; i < 15; i++) {
  const t0 = Date.now();
  try {
    const r = await fetch(RELAY + relayPath, { headers: UA, signal: AbortSignal.timeout(12000) });
    const txt = r.ok ? await r.text() : "";
    let dEven = null;
    if (r.ok) { try { const j = JSON.parse(txt); dEven = j?.dEven ?? null; } catch { /* */ } }
    burst.push({ i, status: r.status, ms: Date.now() - t0, dEven, host: r.headers.get("x-relay-host"), cached: r.headers.get("cf-cache-status") });
  } catch (e) {
    burst.push({ i, error: String(e?.message ?? e), ms: Date.now() - t0 });
  }
}
out.relayBurst.sequential = burst.slice(0, 10);
out.relayBurst.parallel = burst.slice(10);
out.relayBurst.okCount = burst.filter(b => b.status === 200).length;
out.relayBurst.total = burst.length;

// --- 4) Relay daily list (history path) once ---
try {
  const r = await fetch(`${RELAY}?path=${encodeURIComponent(`ClosingPrice/GetClosingPriceDailyList/${KESARAM}/5`)}`, { headers: UA, signal: AbortSignal.timeout(12000) });
  const j = r.ok ? await r.json() : null;
  const arr = j?.closingPriceDaily ?? [];
  out.relayDailyList = { status: r.status, newest: arr.length ? arr[arr.length - 1]?.dEven : null, count: arr.length };
} catch (e) {
  out.relayDailyList = { error: String(e?.message ?? e) };
}

writeFileSync("work/probe-relay-health.json", JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
