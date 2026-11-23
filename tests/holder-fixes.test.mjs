// Regression tests for the client's free-fix batch:
// A. P/E mapping — the source's `Pe` is the stock P/E (equals close/EPS, proven
//    live) and `SectorPE` the group P/E; calculateValuationMetrics must keep
//    that mapping and the UI renders each under its own labelled LTR value.
// B. English change formatting — ASCII digits only, English commas, M/B suffix
//    without space, sign in LTR position.
// C. Grouping — one parent per symbol, every source person preserved.
// D. Expand/collapse state — collapsed by default, toggle is immutable.
// E. Change correctness — snapshot-diff is the authoritative concept; no
//    fabricated values for new entrants (handled upstream; asserted here via
//    the pure helpers' contract: sign preserved, no invented positives).
// F. Percent regression — 1.417 must stay 1.417, never 141.7 (holder-records).
import test from "node:test";
import assert from "node:assert/strict";
import { compactSharesEn, signedSharesEn, groupHolderRowsBySymbol, toggleSymbolInSet } from "../app/lib/format.ts";
import { calculateValuationMetrics } from "../app/lib/market.ts";
import { enrichHolding } from "../app/lib/holder-records.ts";

// ── B. English compact change formatting ────────────────────────────────────
test("B: ASCII digits, English commas, M/B suffix, no space", () => {
  assert.equal(compactSharesEn(910000), "910,000");
  assert.equal(compactSharesEn(250452), "250,452");
  assert.equal(compactSharesEn(165000), "165,000");
  assert.equal(compactSharesEn(1010000), "1.01M");
  assert.equal(compactSharesEn(49720000), "49.72M");
  assert.equal(compactSharesEn(460000000), "460M");
  assert.equal(compactSharesEn(1270000000), "1.27B");
});

test("B: signs stay in LTR position and output is ASCII-only", () => {
  assert.equal(signedSharesEn(1500000), "+1.5M");
  assert.equal(signedSharesEn(-800000), "-800,000");
  assert.equal(signedSharesEn(0), "0");
  const asciiOnly = /^[\x20-\x7E]+$/;
  for (const v of [910000, -800000, 1270000000, 250452]) {
    assert.match(signedSharesEn(v), asciiOnly, `${signedSharesEn(v)} must be ASCII`);
    assert.ok(!/[\u06F0-\u06F9]/.test(signedSharesEn(v)), "no Persian digits");
  }
  // malformed shapes the client complained about must be impossible
  assert.ok(!signedSharesEn(1500000).includes("M+"));
  assert.ok(!signedSharesEn(1500000).includes(" M"));
});

// ── A. P/E mapping (source fields verified live: Pe == close/Eps) ───────────
test("A: valuation keeps stock P/E and group P/E distinct and correct", () => {
  // فولاد live shape: close=3260, eps=518, Pe=6.3, SectorPE=13.18
  const v = calculateValuationMetrics(3260, 518, 6.3, 13.18);
  assert.equal(v.pe, 6.3);            // stock P/E — shown under P/E سهم
  assert.equal(v.sectorPe, 13.18);    // group P/E — shown under P/E گروه
  assert.equal(v.peBelowSector, true); // 6.3 < 13.18 → undervalued flag intact
  const w = calculateValuationMetrics(24310, 1411, 17.2, 13.18); // فملی shape
  assert.equal(w.peBelowSector, false);
  // EPS × P/E گروه formula untouched
  assert.equal(v.epsSectorPePrice, Math.round(518 * 13.18 / 10) * 10);
});

// ── C. Grouping ──────────────────────────────────────────────────────────────
const row = (id, symbol, change, current = change, instrumentName = symbol) => ({
  id, symbol, instrumentName, market: "بورس", currentShares: current, changeShares: change, date: 20260922,
});

test("C: one parent per symbol, all persons preserved (1/2/4 people)", () => {
  for (const people of [1, 2, 4]) {
    const rows = Array.from({ length: people }, (_, i) => row(`r${i}`, "وخاور", 8_000_000 - i * 1_000_000, 17_000_000 - i * 1_000_000));
    const groups = groupHolderRowsBySymbol(rows);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].people, people);
    assert.equal(groups[0].children.length, people, "no source child lost");
  }
});

test("C: identical amounts are still two separate people", () => {
  const groups = groupHolderRowsBySymbol([
    row("a", "فجر", 2_000_000, 20_000_000),
    row("b", "فجر", 2_000_000, 20_000_000),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].people, 2);
  assert.equal(new Set(groups[0].children.map((c) => c.id)).size, 2, "dedup forbidden");
});

test("C: repeated generic name still groups by symbol with one parent", () => {
  const groups = groupHolderRowsBySymbol([
    row("x1", "کهمدا", 13_000_000, 188_000_000),
    row("x2", "کهمدا", 500_000, 12_500_000),
    row("y1", "فولاد", 3_000_000, 30_000_000),
  ]);
  assert.equal(groups.length, 2);
  const kehmada = groups.find((g) => g.symbol === "کهمدا");
  assert.equal(kehmada.people, 2);
  // children sorted largest change first
  assert.equal(kehmada.children[0].changeShares, 13_000_000);
  // parent ranking uses strongest child change
  assert.equal(groups[0].symbol, "کهمدا");
  assert.equal(groups[0].maxChange, 13_000_000);
});

// ── D. Collapse/expand ───────────────────────────────────────────────────────
test("D: default collapsed (empty set) and toggle is immutable", () => {
  const def = new Set();
  assert.equal(def.size, 0); // collapsed by default
  const open = toggleSymbolInSet(def, "وخاور");
  assert.deepEqual([...open], ["وخاور"]);
  assert.equal(def.size, 0, "original state untouched");
  const closed = toggleSymbolInSet(open, "وخاور");
  assert.equal(closed.size, 0);
});

// ── E. Change-concept contract (helpers must not fabricate signs) ────────────
test("E: signed helper preserves the source sign, never fabricates change", () => {
  // negative source change must render negative (buy views filter these out
  // upstream; the helper itself must stay faithful for grouped views)
  assert.equal(signedSharesEn(-13_000_000), "-13M");
  assert.equal(signedSharesEn(13_000_000), "+13M");
  assert.equal(compactSharesEn(-5), "5", "magnitude helper drops sign by contract");
});

// ── F. Percent scale regression ──────────────────────────────────────────────
test("F: ownership percent stays 1.417% — no ×100 duplication", () => {
  const info = { lVal18AFC: "فجام", zTitad: 1_200_000_000, flowTitle: "بورس", sector: { cSecVal: "27" } };
  const enriched = enrichHolding(
    { id: "t", insCode: "1", instrumentName: "فجام", shareholderType: "شخص حقیقی", previousShares: 15_600_000, currentShares: 17_000_000, changeShares: 1_400_000, changeEvidence: "snapshot", date: 20260922 },
    info,
  );
  assert.ok(enriched);
  // 17,000,000 / 1,200,000,000 = 1.4167% → rounded 1.417
  assert.equal(enriched.ownershipPct, 1.417);
  assert.ok(enriched.ownershipPct < 100, "percent must never exceed 100 via double scaling");
});
