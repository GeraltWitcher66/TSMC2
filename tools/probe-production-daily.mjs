// Production verification for the NEW daily divergence deployment.
const BASE = "https://iran-stock-screener.ar-nikzad09.workers.dev";
const ts = Date.now();
const html = await (await fetch(`${BASE}/?_=${ts}`, { headers: { "Cache-Control": "no-cache" } })).text();
console.log("HTTP page:", html.includes("فیلتر بورس") ? "200 OK, Persian app found" : "UNEXPECTED", "| bytes:", html.length);

// The new bundle must NOT contain old pivot wording and MUST contain new wording.
const oldWords = ["تشکیل الگو", "شکست سطح تأیید", "سقف اول", "کف اول"];
for (const w of oldWords) console.log(`old wording "${w}" in bundle:`, html.includes(w) ? "PRESENT (BAD)" : "absent");
// client bundle sits in an asset script; check page + try the api
const universe = await (await fetch(`${BASE}/api/market-universe`)).json();
const syms = (universe.symbols ?? universe).map((s) => s.symbol ?? s);
console.log("universe:", syms.length);

// Screener API: verify divergence shape end to end.
const symSample = syms.slice(0, 30);
const apiRes = await fetch(`${BASE}/api/screener?_=${ts}`, { method: "POST", headers: { "Cache-Control": "no-cache", "Content-Type": "application/json" }, body: JSON.stringify({ symbols: symSample }) });
console.log("screener API:", apiRes.status);
if (apiRes.ok) {
  const data = await apiRes.json();
  const rows = data.rows ?? [];
  const withAnalysis = rows.filter((r) => r.divergenceAnalysis);
  const statuses = {};
  for (const r of withAnalysis) statuses[r.divergenceAnalysis.status] = (statuses[r.divergenceAnalysis.status] ?? 0) + 1;
  console.log("rows:", rows.length, "with analysis:", withAnalysis.length, "statuses:", JSON.stringify(statuses));
  const sample = withAnalysis.find((r) => r.divergence) ?? withAnalysis[0];
  if (sample) {
    console.log("SAMPLE:", sample.symbol, JSON.stringify({
      status: sample.divergenceAnalysis.status,
      version: sample.divergenceAnalysis.version,
      divergence: sample.divergence,
      rsi: sample.rsi,
      asOf: sample.divergenceAnalysis.asOfDate,
      previousDate: sample.divergenceAnalysis.previousDate,
    }));
    const bad = withAnalysis.filter((r) => r.divergence && (!r.divergence.previous || !r.divergence.latest || r.divergence.previous.date === null));
    console.log("malformed divergence objects:", bad.length);
  }
}
