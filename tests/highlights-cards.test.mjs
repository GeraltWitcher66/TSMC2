// Layout contract for the «بیشترین‌های فهرست» tab: eight cards in the client's
// order, the three ranked cards sharing one compact table, and the two new
// value formulas (shareholder change value and the five-session window).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compactSharesFa, holderChangeValueToman } from "../app/lib/format.ts";
import { sessionFlow, weeklySummary } from "../app/lib/weekly-real-money.ts";

const clientSource = readFileSync("app/ScreenerClient.tsx", "utf8");
const panelStart = clientSource.indexOf("function renderHighlightsPanel");
const panel = clientSource.slice(panelStart, clientSource.indexOf("function renderSummaryGrid"));

test("shareholder change value is change × closing price ÷ 10 in Toman", () => {
  assert.equal(holderChangeValueToman(80_000_000, 12_340), 98_720_000_000);
  assert.equal(holderChangeValueToman(-2_000_000, 5_000), -1_000_000_000);
  assert.equal(holderChangeValueToman(10, 0), null, "no usable price means no value");
  assert.equal(holderChangeValueToman(10, null), null);
});

test("share changes use Persian digits with the M/B suffixes", () => {
  assert.equal(compactSharesFa(80_000_000), "۸۰M");
  assert.ok(compactSharesFa(1_500_000_000).endsWith("B"), "billions keep the B suffix");
  assert.equal(compactSharesFa(-80_000_000), "-۸۰M");
});

test("five sessions +10, −3, +2, 0, +1 total +10", () => {
  const summary = weeklySummary([10, -3, 2, 0, 1]);
  assert.equal(summary.net, 10);
  assert.equal(summary.covered, 5);
});

test("one session contributes net, trade value and buyer/seller counts", () => {
  const flow = sessionFlow({ buy_I_Value: 500, sell_I_Value: 200, buy_I_Count: 5, sell_I_Count: 4 }, 1_000, 900);
  assert.equal(flow.net, 300);
  assert.equal(flow.value, 900);
  assert.equal(flow.buyValue, 500);
  assert.equal(flow.buyCount, 5);
  assert.equal(flow.sellCount, 4);
});

test("the tab renders the eight cards in the requested order", () => {
  const cards = [
    { number: "۱", title: "ورود پول به صنعت روزانه" },
    { number: "۲", title: "ورود پول به صنعت (۳ روزه)" },
    { number: "۳", title: "بیشترین ارزش تغییرات سهامدار عمده" },
    { number: "۴", title: "بیشترین ورود پول حقیقی (روزانه)" },
    { number: "۵", title: "بیشترین ورود پول حقیقی (هفتگی)" },
    { number: "۶", title: "بیشترین ارزش معاملات" },
    { number: "۷", title: "بیشترین حجم معاملات" },
  ];
  let cursor = -1;
  for (const card of cards) {
    const titleAt = panel.indexOf(card.title, cursor + 1);
    assert.ok(titleAt > cursor, `card ${card.number} (${card.title}) is in order`);
    const numberAt = panel.indexOf(`number="${card.number}"`, cursor + 1);
    assert.ok(numberAt > 0 && numberAt < titleAt, `card ${card.number} keeps its hard-coded number`);
    cursor = titleAt;
  }
  // Card 8 is the reversal list; its number lives inside ReversalHighlightCard.
  assert.ok(panel.indexOf("<ReversalHighlightCard") > cursor, "reversal card is last");
  assert.ok(clientSource.includes('<span className="highlight-number">۸</span>'), "reversal card is numbered ۸");
});

test("the old shareholder card and its expand state are gone from the tab", () => {
  assert.ok(!panel.includes("تغییرات سهامدار حقیقی"), "removed card title is gone");
  assert.ok(!panel.includes("holder-highlight-card"), "removed card markup is gone");
  assert.ok(!clientSource.includes("highlightOpenGroups"), "removed expand state is gone");
  assert.ok(!clientSource.includes("showAllHighlightHolders"), "removed show-all state is gone");
  // The ranking still needs the shareholder data, so the shared loader stays.
  assert.ok(clientSource.includes("highlightHoldings?.rows"), "card 3 reads the existing shareholder data");
});

test("cards 3, 4 and 5 use the shared compact table and its twenty rows", () => {
  assert.equal((panel.match(/<RankedTableCard /g) ?? []).length, 3);
  const component = clientSource.slice(clientSource.indexOf("function RankedTableCard"), clientSource.indexOf("// ─── Symbol parsing"));
  assert.ok(component.includes(".slice(0, 20)"), "only the first twenty rows are shown");
  assert.ok(component.includes("industry-sort"), "headers reuse the industry sort buttons");
  assert.ok(component.includes("industry-help"), "each card offers the formula help button");
  assert.ok(component.includes("industry-formulas"), "the help box reuses the industry styles");
});

test("card 3 columns: symbol, holder, change, value, then the shared price columns", () => {
  const columns = clientSource.match(/const HOLDER_VALUE_COLUMNS[\s\S]*?\];/);
  assert.ok(columns, "holder column list found");
  let cursor = -1;
  for (const label of ["نماد", "نام سهامدار", "تغییرات", "ارزش (تومان)"]) {
    const at = columns[0].indexOf(label, cursor + 1);
    assert.ok(at > cursor, `column ${label} keeps its place`);
    cursor = at;
  }
  assert.ok(columns[0].includes("...rankPriceColumns"), "the four price columns are appended");
  const price = clientSource.match(/const rankPriceColumns[\s\S]*?\];/);
  assert.ok(price, "price column list found");
  cursor = -1;
  for (const label of ["آخرین معامله (ریال)", "پایانی (ریال)", "اختلاف (%)", "تاریخ"]) {
    const at = price[0].indexOf(label, cursor + 1);
    assert.ok(at > cursor, `price column ${label} keeps its place`);
    cursor = at;
  }
});

test("cards 4 and 5 dropped the price-change column and share the real-money columns", () => {
  const columns = clientSource.match(/const REAL_MONEY_COLUMNS[\s\S]*?\];/);
  assert.ok(columns, "real-money column list found");
  let cursor = -1;
  for (const label of ["نماد", "سرانه خرید", "ارزش معاملات (تومان)", "ورود پول (تومان)"]) {
    const at = columns[0].indexOf(label, cursor + 1);
    assert.ok(at > cursor, `column ${label} keeps its place`);
    cursor = at;
  }
  assert.ok(columns[0].includes("...rankPriceColumns"), "the four price columns are appended");
  assert.ok(!columns[0].includes("درصد تغییر"), "the price-change column is not back");
  assert.ok(!clientSource.includes("ستون درصد تغییر"), "no leftover price-change column label");
});

test("card 8 has a titled header for every column it shows", () => {
  const card = clientSource.match(/function ReversalHighlightCard[\s\S]*?<\/article>/);
  assert.ok(card, "reversal card found");
  const order = ["نماد", "آخرین معامله (ریال)", "پایانی (ریال)", "اختلاف (%)", "تاریخ"];
  let cursor = -1;
  for (const label of order) {
    const at = card[0].indexOf(label, cursor + 1);
    assert.ok(at > cursor, `header ${label} is present in order`);
    cursor = at;
  }
});
