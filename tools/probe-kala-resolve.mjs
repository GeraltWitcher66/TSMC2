// کالا acceptance: official share change exists (20260607, 29B→62B, ratio 2.1379).
// The observed reference gap: 5000/11230 = 0.4452. 1/2.1379 = 0.4677.
import { resolveAnalysisAdjustments, analyzeDivergence } from "../app/lib/divergence.ts";

const res = await fetch("https://zarvanfund.ir/api/daily-batch?limit=260&syms=" + encodeURIComponent("کالا"), { headers: { Accept: "application/json" } });
const data = await res.json();
const candles = [...(data["کالا"] ?? Object.values(data)[0])].sort((a, b) => a.d_even - b.d_even);

const changes = [{ date: 20260607, oldShares: 29000000000, newShares: 62000000000 }];
const resolution = resolveAnalysisAdjustments(candles, changes);
console.log("effective:", JSON.stringify(resolution.effective));
console.log("unresolved:", JSON.stringify(resolution.unresolved));

const newest = candles.at(-1).d_even;
const now = new Date(`${String(newest).slice(0, 4)}-${String(newest).slice(4, 6)}-${String(newest).slice(6, 8)}T10:30:00Z`);
const withChanges = analyzeDivergence(candles, changes, 90, { now });
console.log("with official data: status=", withChanges.status, "active=", withChanges.active ? `${withChanges.active.type}/${withChanges.active.state}` : "null");
const withoutChanges = analyzeDivergence(candles, [], 90, { now });
console.log("without official data: status=", withoutChanges.status, "reason:", withoutChanges.reason.slice(0, 60));
