// Pure helpers shared between the screener UI and the regression tests.

// English/ASCII compact share formatting for the client-requested "تعداد تغییر"
// numeric area: ASCII digits, English comma separators, English M/B suffix with
// NO space, sign always in LTR position. Persian digits stay everywhere else.
const enN = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

export function compactSharesEn(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${enN.format(Math.round(abs / 1e9 * 100) / 100)}B`;
  if (abs >= 1e6) return `${enN.format(Math.round(abs / 1e6 * 100) / 100)}M`;
  return enN.format(Math.round(abs));
}

export function signedSharesEn(v: number): string {
  return v > 0 ? `+${compactSharesEn(v)}` : v < 0 ? `-${compactSharesEn(v)}` : compactSharesEn(v);
}

export type GroupableHolderRow = {
  id: string; symbol: string; instrumentName: string; market: string;
  currentShares: number; changeShares: number; date: number;
};

export type HolderSymbolGroup<T extends GroupableHolderRow> = {
  id: string; symbol: string; instrumentName: string; market: string;
  people: number; maxChange: number; date: number; children: T[]; representative: T;
};

/**
 * ONE parent row per symbol (client spec: no scattered duplicate symbol rows).
 * Children are ALL source real-person records — never aggregated, never
 * deduplicated (two equal amounts are still two people). Children are sorted
 * largest change first. Parent rank uses the strongest child's change, which
 * preserves the largest-first ranking semantics of the holder views.
 */
export function groupHolderRowsBySymbol<T extends GroupableHolderRow>(rows: T[]): HolderSymbolGroup<T>[] {
  const groups: HolderSymbolGroup<T>[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.symbol)) continue;
    seen.add(row.symbol);
    const children = rows.filter((r) => r.symbol === row.symbol)
      .sort((a, b) => b.changeShares - a.changeShares || b.currentShares - a.currentShares || a.id.localeCompare(b.id));
    const representative = [...children].sort((a, b) => b.currentShares - a.currentShares || a.id.localeCompare(b.id))[0];
    groups.push({
      id: `grp-${row.symbol}`, symbol: row.symbol,
      instrumentName: children[0]?.instrumentName ?? "", market: children[0]?.market ?? "",
      people: children.length, maxChange: children[0]?.changeShares ?? 0,
      date: representative.date, children, representative,
    });
  }
  return groups.sort((a, b) => b.maxChange - a.maxChange);
}

/** Immutable add/remove toggle used by the collapse/expand sets. */
export function toggleSymbolInSet(open: Set<string>, symbol: string): Set<string> {
  const next = new Set(open);
  if (next.has(symbol)) next.delete(symbol); else next.add(symbol);
  return next;
}
