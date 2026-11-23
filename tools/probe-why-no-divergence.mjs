// Debug: why does the bullish fixture not produce an active event here?
import { analyzeDivergence } from "../app/lib/divergence.ts";
import { divergenceSeries, asOf } from "../tests/helpers/divergence-series.mjs";

const candles = divergenceSeries(false, [90, 96, 98]);
const a = analyzeDivergence(candles, [], 90, { now: asOf(candles) });
console.log("fixture via asOf: status=", a.status, "active=", a.active ? a.active.type : null);

const recalcNow = new Date();
const b = analyzeDivergence(candles, [], 90, { now: recalcNow });
console.log("fixture via real now:", b.status, b.active ? b.active.type : null, "reason:", b.reason.slice(0, 50));
console.log("asOf date:", asOf(candles).toISOString(), "| last candle:", candles.at(-1).d_even);
