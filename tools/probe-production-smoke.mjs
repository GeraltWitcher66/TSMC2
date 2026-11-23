// Production smoke test for the new deployment.
const base = "https://iran-stock-screener.ar-nikzad09.workers.dev";
const ts = Date.now();
const html = await (await fetch(base + "/?_=" + ts, { headers: { "Cache-Control": "no-cache" } })).text();
console.log("HTTP page:", html.includes("فیلتر بورس") ? "200 OK, Persian app found" : html.slice(0, 200));
const api = await fetch(base + "/api/market-universe");
const uni = await api.json();
console.log("universe symbols:", (uni.symbols ?? []).length);
// Test production screener API for symbols with known active divergences.
const res = await fetch(base + "/api/screener", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ symbols: ["پاکشو", "دارو", "سامان", "کسرام"] }),
});
const data = await res.json();
console.log("screener HTTP:", res.status, "latestDate:", data.latestDate);
for (const row of (data.rows ?? [])) {
  const d = row.divergence;
  console.log(row.symbol, "| status:", row.status, "| divergence:", d ? d.type + "/" + d.state + " " + d.startDate + "→" + (d.endDate ?? "open") : "none", "| RSI:", row.rsi);
}
// Holders API: failed upstream must be null, never fake zero.
const holders = await fetch(base + "/api/holders", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ symbols: ["کسرام", "فولاد"] }),
});
const hc = await holders.json();
console.log("holders HTTP:", holders.status, "counts:", JSON.stringify(hc.counts));
