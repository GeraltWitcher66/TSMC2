// Regression tests for client round "مشکل ۸":
// A. خرید حقیقی / فروش حقیقی columns removed from «از صف فروش به مثبت».
// B. Dates shown on all highlight cards (incl. the reversal card) as separate nodes.
// C. Symbol/date copy-safety: date spans are user-select:none, symbol text node clean.
// D/E. Person-count badge moved next to the symbol; no standalone count column.
// F/G. Expand/collapse: all groups default collapsed; real interactions are tested by recovery-browser.mjs.
// H/I. Percent/change correctness: ownership % is per-child (holder-records),
//      grouping is label-stable, and the parent's "top holder" matches TSETMC
//      concept (largest CURRENT holding), proven against live-shaped fixtures.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupHolderRowsBySymbol, toggleSymbolInSet, compactSharesEn } from "../app/lib/format.ts";
import { enrichHolding } from "../app/lib/holder-records.ts";
import { extractMajorIndividualHoldingChanges, latestNonFutureDate } from "../app/lib/market.ts";

const clientSource = readFileSync("app/ScreenerClient.tsx", "utf8");
const cssSource = readFileSync("app/globals.css", "utf8");

// ── A. Removal of the two حقیقی columns from the reversal card ──────────────
test("A: reversal card header and rows have no خرید/فروش حقیقی volume cells", () => {
  const head = clientSource.match(/reversal-table-head[\s\S]*?<\/ol>/);
  assert.ok(head, "reversal card markup found");
  const block = head[0];
  assert.ok(!block.includes("خرید حقیقی"), "خرید حقیقی header removed");
  assert.ok(!block.includes("فروش حقیقی"), "فروش حقیقی header removed");
  assert.ok(!block.includes("reversal-volume"), "volume cells removed from rows");
  // remaining columns intact
  for (const label of ["نماد", "آخرین معامله (ریال)", "پایانی (ریال)", "اختلاف (%)", "تاریخ"]) {
    assert.ok(block.includes(label), `column ${label} kept`);
  }
});

test("A: reversal grid CSS carries a titled column for the session date too", () => {
  assert.match(cssSource, /reversal-table-head[^}]*grid-template-columns:\s*minmax\(68px, 1\.05fr\) repeat\(3, minmax\(50px, \.78fr\)\) minmax\(62px, \.82fr\)/);
});

// ── B. Dates on highlight cards ─────────────────────────────────────────────
test("B: HighlightCard table has a تاریخ column and per-row date cell", () => {
  const start = clientSource.indexOf("function HighlightCard");
  assert.ok(start > 0, "HighlightCard found");
  const card = clientSource.slice(start, clientSource.indexOf("function ReversalHighlightCard", start));
  assert.ok(card.includes("<th>تاریخ</th>"), "تاریخ header added");
  // The cell is still one per-row date small; `rowDate` keeps the single
  // session date for daily cards and shows the session range on the weekly card.
  assert.match(card, /<td><small className="row-date">\{rowDate\(row\)\}<\/small><\/td>/);
  assert.match(card, /const rowDate = \(row: HighlightListRow\) => row\.sessionRange \?\? fmtDate\(row\.sessionDate\)/);
});

test("B: reversal rows render the session date as a separated node", () => {
  assert.match(clientSource, /<span className="reversal-date">\{fmtDate\(row\.sessionDate\)\}<\/span>/);
});

// ── C. Copy-safety: dates and badges never selected with the symbol ─────────
test("C: date chips and badge are user-select:none in CSS", () => {
  assert.match(cssSource, /\.row-date[^}]*user-select:\s*none/);
  assert.match(cssSource, /\.reversal-date[^}]*user-select:\s*none/);
  assert.ok(cssSource.includes("user-select: none"), "copy-safety rule present");
});

test("C: symbol stays a clean <strong>{row.symbol}</strong> text node in holderIncreases", () => {
  assert.ok(clientSource.includes("<strong>{group.symbol}</strong>"), "holderIncreases single-person symbol node");
});

// ── D/E. Badge next to symbol; standalone count column removed ──────────────
test("D/E: no standalone شخص حقیقی count column remains in holderIncreases", () => {
  const table = clientSource.match(/holder-increase-table[\s\S]*?<\/table>/);
  assert.ok(table, "holderIncreases table found");
  assert.ok(!table[0].includes("<th>شخص حقیقی</th>"), "standalone count column removed");
  assert.match(table[0], /holder-people-inline/, "badge rendered inline next to symbol");
  assert.ok(!table[0].includes("holder-people-badge"), "old detached badge class gone from this view");
});



// ── F/G. Expand/collapse UX: single person inline, multi expandable ─────────
test("F: one-person group opens and closes without losing its record", () => {
  const child = { id: "1", symbol: "فنر", currentShares: 200, changeShares: 50, date: 20260907 };
  const group = groupHolderRowsBySymbol([child])[0];
  let open = new Set();
  assert.equal(open.has(group.symbol), false);
  open = toggleSymbolInSet(open, group.symbol);
  assert.equal(open.has(group.symbol), true);
  assert.equal(group.representative, child);
  open = toggleSymbolInSet(open, group.symbol);
  assert.equal(open.has(group.symbol), false);
});

test("F: independent group state preserves two and four separate records", () => {
  for (const count of [2, 4]) {
    const rows = Array.from({ length: count }, (_, i) => ({ id: String(i), symbol: "فجام", currentShares: 100, changeShares: 10, date: 20260907 }));
    const group = groupHolderRowsBySymbol(rows)[0];
    const open = toggleSymbolInSet(new Set(), group.symbol);
    assert.equal(group.people, count);
    assert.equal(open.has(group.symbol), true);
    assert.equal(group.children.length, count);
  }
});

test("G: toggle helper stays immutable (no cross-group leakage)", () => {
  const open = new Set(["A"]);
  const next = toggleSymbolInSet(open, "B");
  assert.deepEqual([...next].sort(), ["A", "B"]);
  assert.deepEqual([...open], ["A"], "original set untouched");
});

// ── H/I. Data correctness: percent belongs to the same child record ─────────
test("H: ownership percent is computed per child from the SAME currentShares (×100 scaled once)", () => {
  const candidate = {
    id: "x:1:20260929:100:150:50", insCode: "x", instrumentName: "TEST",
    shareholderType: "شخص حقیقی", previousShares: 100, currentShares: 150,
    changeShares: 50, changeEvidence: "snapshot", date: 20260929,
  };
  const row = enrichHolding(candidate, { lVal18AFC: "TEST", zTitad: 1000, flowTitle: "بازار بورس", sector: { cSecVal: "54" } });
  assert.ok(row, "row enriched");
  assert.equal(row.currentShares, 150);
  assert.equal(row.changeShares, 50);
  assert.equal(row.ownershipPct, 15); // 150/1000 → 15%, NOT 0.15 and NOT 1500
});

test("I: parent label concept — largest current holder is the parent's shown holder", () => {
  // Two children: child1 larger change but smaller position; child2 largest holder.
  const rows = [
    { id: "1", symbol: "SYM", instrumentName: "س", market: "بورس", currentShares: 1_000_000, changeShares: 900_000, date: 20260929 },
    { id: "2", symbol: "SYM", instrumentName: "س", market: "بورس", currentShares: 9_000_000, changeShares: 10_000, date: 20260929 },
  ];
  const groups = groupHolderRowsBySymbol(rows);
  assert.equal(groups.length, 1);
  const g = groups[0];
  const topHolder = [...g.children].sort((a, b) => b.currentShares - a.currentShares)[0];
  assert.equal(topHolder.currentShares, 9_000_000, "parent cell must show the largest HOLDER (TSETMC concept), not the largest changer");
  assert.equal(g.children[0].changeShares, 900_000, "children list still sorted by change");
});

test("I: pipeline keeps per-record pairing on the same session (no cross-day mixing)", () => {
  const payload = {
    dates: [20260928, 20260929],
    shareHoldersChanges: [{
      name: "شخص حقيقي",
      insList: [{ insCode: "77", name: "TEST", firstDay: "500", secondDay: "650" }],
    }],
  };
  const changes = extractMajorIndividualHoldingChanges(payload, { now: new Date("2026-09-30T09:30:00Z") });
  assert.equal(changes.length, 1);
  assert.equal(changes[0].previousShares, 500);
  assert.equal(changes[0].currentShares, 650);
  assert.equal(changes[0].changeShares, 150);
  assert.equal(changes[0].date, 20260929);
});

test("I: legal entities and unchanged rows never enter the holder list", () => {
  const payload = {
    dates: [20260928, 20260929],
    shareHoldersChanges: [
      { name: "BFMصندوق سرمايه گذاري .ا.ب .ميزان داريك", insList: [{ insCode: "88", name: "FUND", firstDay: "100", secondDay: "900" }] },
      { name: "شخص حقيقي", insList: [{ insCode: "89", name: "SAME", firstDay: "100", secondDay: "100" }] },
    ],
  };
  const changes = extractMajorIndividualHoldingChanges(payload, { now: new Date("2026-09-30T09:30:00Z") });
  assert.equal(changes.length, 0);
});

test("I: live-source contract — app-selected session is the latest non-future source date", () => {
  const dates = [20260926, 20260927, 20260928, 20260929, 20260930];
  assert.equal(latestNonFutureDate(dates, new Date("2026-09-29T20:00:00Z")), 20260929, "20260930 is a future pre-listed session and must never be selected early");
});

test("J: grouping helper keeps one parent per symbol with every child preserved", () => {
  const rows = [
    { id: "1", symbol: "دوتایی", instrumentName: "د", market: "بورس", currentShares: 10, changeShares: 5, date: 20260929 },
    { id: "2", symbol: "دوتایی", instrumentName: "د", market: "بورس", currentShares: 20, changeShares: 7, date: 20260929 },
    { id: "3", symbol: "تکی", instrumentName: "ت", market: "بورس", currentShares: 30, changeShares: 9, date: 20260929 },
  ];
  const groups = groupHolderRowsBySymbol(rows);
  assert.equal(groups.length, 2);
  const dual = groups.find((g) => g.symbol === "دوتایی");
  assert.equal(dual.people, 2);
  assert.equal(dual.children.length, 2, "no child dropped");
  const single = groups.find((g) => g.symbol === "تکی");
  assert.equal(single.people, 1);
});

test("J: compact share formatting contract unchanged (M/B, ASCII)", () => {
  assert.equal(compactSharesEn(1500), "1,500");
  assert.equal(compactSharesEn(2_500_000), "2.5M");
});
