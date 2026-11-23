// Regression check: quoteVerified=false must NOT erase a real divergence.
import { recalculateScreenerRow } from "../app/lib/screener-analysis.ts";
import { divergenceSeries, asOf } from "../tests/helpers/divergence-series.mjs";

const candles = divergenceSeries(false, [90, 96, 98]); // bullish event
const now = asOf(candles);
const row = {
  symbol: "TEST", name: "تست", insCode: "1", rsi: null, realHolders: null,
  three: null, six: null, actions: [], status: "ready",
  analysisInput: { candles, changes: [], eps: 100, pe: 10, sectorPe: 8 },
};
const forVerified = recalculateScreenerRow(row, candles, [], true, now);
const forUnverified = recalculateScreenerRow(row, candles, [], false, now);
console.log("quoteVerified=true : status=", forVerified.status, " divergence=", forVerified.divergence ? `${forVerified.divergence.type}/${forVerified.divergence.state}` : "null");
console.log("quoteVerified=false: status=", forUnverified.status, " divergence=", forUnverified.divergence ? `${forUnverified.divergence.type}/${forUnverified.divergence.state}` : "null");
// Serialization round-trip: the API drops nothing?
const serialized = JSON.parse(JSON.stringify(forUnverified));
console.log("JSON round-trip keeps divergence:", serialized.divergence !== null && serialized.divergence.type === "bullish");
if (!forUnverified.divergence) { console.error("FAIL: divergence erased when quote unverified"); process.exit(1); }
console.log("PASS");
