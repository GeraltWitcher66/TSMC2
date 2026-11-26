/**
 * The source publishes whole-market industry aggregates in `/api/sectors`.
 * Rebuilding an industry from whichever symbols happen to sit in a watchlist
 * gives partial totals, so both the Worker route and the browser read this
 * feed unchanged and only normalise its shape.
 */
export const INDUSTRY_SOURCE_URL = "https://zarvanfund.ir/api/sectors";

export type IndustryRow = {
  code: string;
  name: string;
  /** Net real-money inflow in Rial. */
  net: number | null;
  /** Traded value in Rial. */
  value: number | null;
  buyPower: number | null;
  symbols: number;
};

type RawSector = {
  sector_code?: string | number; sector_name?: string;
  net_real?: number | string; value?: number | string;
  buy_power?: number | string; symbols?: number | string;
};

const numberOrNull = (value: unknown) => {
  // Number(null) and Number("") are 0, which would invent a real value.
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Rows are ranked by net money inflow; unknown inflows sort last. */
export function parseIndustries(payload: unknown): IndustryRow[] {
  if (!Array.isArray(payload)) throw new Error("ساختار فهرست صنایع معتبر نیست.");
  const rows = payload.flatMap((item) => {
    const raw = (item ?? {}) as RawSector;
    const name = String(raw.sector_name ?? "").trim();
    if (!name) return [];
    return [{
      code: String(raw.sector_code ?? "").trim(),
      name,
      net: numberOrNull(raw.net_real),
      value: numberOrNull(raw.value),
      buyPower: numberOrNull(raw.buy_power),
      symbols: Math.max(0, Math.round(numberOrNull(raw.symbols) ?? 0)),
    }];
  });
  if (!rows.length) throw new Error("نام صنایع در منبع موجود نیست.");
  return rows.sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
}

/** One recorded session of industry totals, keyed by its market session date. */
export type IndustrySnapshot = { date: number; rows: IndustryRow[] };

const SNAPSHOT_KEY = "ss-industry-snapshots-v1";
const snapshotKeyOf = (row: { code: string; name: string }) => row.code || row.name;

/** Keep the newest snapshot per session date, at most `keep` dates. */
export function upsertIndustrySnapshot(
  previous: IndustrySnapshot[], date: number | null | undefined, rows: IndustryRow[], keep = 10,
): IndustrySnapshot[] {
  if (!date || !rows.length) return previous;
  const others = previous.filter((snapshot) => snapshot.date !== date);
  return [...others, { date, rows }].sort((a, b) => a.date - b.date).slice(-keep);
}

/**
 * Sums the last `sessions` recorded sessions per industry. Money inflow and
 * traded value add up; buy power is a ratio, so the newest session's value is
 * kept instead of adding ratios together.
 */
export function sumIndustrySessions(snapshots: IndustrySnapshot[], sessions = 3): IndustryRow[] {
  const selected = [...snapshots].sort((a, b) => b.date - a.date).slice(0, Math.max(1, sessions));
  if (!selected.length) return [];
  const totals = new Map<string, IndustryRow>();
  for (const snapshot of selected) {
    for (const row of snapshot.rows) {
      const key = snapshotKeyOf(row);
      const current = totals.get(key) ?? { code: row.code, name: row.name, net: null, value: null, buyPower: null, symbols: 0 };
      if (row.net !== null) current.net = (current.net ?? 0) + row.net;
      if (row.value !== null) current.value = (current.value ?? 0) + row.value;
      totals.set(key, current);
    }
  }
  const newest = selected[0];
  return [...totals.entries()]
    .map(([key, row]) => {
      const latest = newest.rows.find((candidate) => snapshotKeyOf(candidate) === key);
      return { ...row, buyPower: latest?.buyPower ?? null, symbols: latest?.symbols ?? 0 };
    })
    .sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
}

export function readIndustrySnapshots(): IndustrySnapshot[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SNAPSHOT_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const date = Number(item?.date);
      const rows = Array.isArray(item?.rows) ? item.rows : [];
      return Number.isFinite(date) && date > 0 && rows.length ? [{ date, rows: rows as IndustryRow[] }] : [];
    });
  } catch { return []; }
}

export function writeIndustrySnapshots(snapshots: IndustrySnapshot[]): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots)); } catch { /* storage is optional */ }
}
