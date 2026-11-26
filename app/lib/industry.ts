/**
 * Industry aggregates for the "بیشترین‌های فهرست" tab.
 *
 * The source feed (`/api/sectors`) publishes its own whole-market totals, but
 * its `buy_power` is a plain mean of per-symbol ratios: one outlier symbol
 * (a 368× ratio) drags an industry from 1.38 to 11.16. The screener therefore
 * rebuilds inflow, traded value and buy power from per-symbol data and only
 * falls back to the source feed when that symbol data is unavailable.
 */
export const INDUSTRY_SOURCE_URL = "https://zarvanfund.ir/api/sectors";

export type IndustryRow = {
  code: string;
  name: string;
  /** Net real-money inflow in Rial: Σ (real buy volume − real sell volume) × closing price. */
  net: number | null;
  /** Traded value in Rial. */
  value: number | null;
  /**
   * (Σ real buy value ÷ Σ real buyers) ÷ (Σ real sell value ÷ Σ real sellers).
   * A ratio is never averaged with another ratio, and `null` means "unknown".
   */
  buyPower: number | null;
  symbols: number;
  /** Components kept so a multi-session card can re-aggregate instead of adding ratios. */
  realBuyValue: number | null;
  realSellValue: number | null;
  buyCount: number | null;
  sellCount: number | null;
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
      realBuyValue: null,
      realSellValue: null,
      buyCount: null,
      sellCount: null,
    }];
  });
  if (!rows.length) throw new Error("نام صنایع در منبع موجود نیست.");
  return [...rows].sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity));
}

/** Sector code → published sector name, used to label per-symbol aggregates. */
export function sectorNameMap(rows: IndustryRow[]): Record<string, string> {
  return Object.fromEntries(rows.filter((row) => row.code).map((row) => [row.code, row.name]));
}

/**
 * Aggregate buy power. Each side is a per-person average, so the industry
 * total is the ratio of two sums, never the mean of per-symbol ratios.
 */
export function aggregateBuyPower(
  realBuyValue: number | null, buyCount: number | null,
  realSellValue: number | null, sellCount: number | null,
): number | null {
  if (!realBuyValue || !buyCount || !realSellValue || !sellCount) return null;
  if (realBuyValue <= 0 || buyCount <= 0 || realSellValue <= 0 || sellCount <= 0) return null;
  return (realBuyValue / buyCount) / (realSellValue / sellCount);
}

/** The source feed cannot supply trustworthy buy power, so the fallback shows "—". */
export function withoutBuyPower(rows: IndustryRow[]): IndustryRow[] {
  return rows.map((row) => ({ ...row, buyPower: null, realBuyValue: null, realSellValue: null, buyCount: null, sellCount: null }));
}

// ─── Display helpers ────────────────────────────────────────────────────────
const faOne = new Intl.NumberFormat("fa-IR", { maximumFractionDigits: 1 });

/**
 * Short, unit-suffixed amount for a compact table: T = thousand billion Toman,
 * B = billion Toman, M = million Toman. Source figures are Rial, the reference
 * table is Toman, so the value is divided by ten first.
 */
export function compactToman(rial: number | null | undefined): string {
  if (rial === null || rial === undefined || !Number.isFinite(rial)) return "—";
  const toman = rial / 10;
  const abs = Math.abs(toman);
  // A direction mark or the Persian minus inside a LTR cell would break alignment.
  const format = (value: number) => faOne.format(value).replace("٫", ".").replace("−", "-").replace(/\u200e/g, "");
  if (abs >= 1e12) return `${format(toman / 1e12)}T`;
  if (abs >= 1e9) return `${format(toman / 1e9)}B`;
  if (abs >= 1e6) return `${format(toman / 1e6)}M`;
  return format(toman);
}

const NAME_ALIASES: Record<string, string> = {
  "فلزات اساسی": "فلزات",
  "محصولات شیمیایی": "شیمیایی",
  "استخراج کانه های فلزی": "کانه فلزی",
  "کانه های فلزی": "کانه فلزی",
  "فنی و مهندسی": "فنی و مهندسی",
  "عرضه برق، گاز، بخاروآب گرم": "عرضه برق",
  "عرضه برق، گاز، بخار و آب گرم": "عرضه برق",
  "انبوه سازی، املاک و مستغلات": "انبوه سازی",
  "فراورده های نفتی، کک و سوخت هسته ای": "نفتی",
  "فرآورده های نفتی، کک و سوخت هسته ای": "نفتی",
  "سرمایه گذاریها": "سرمایه گذاری",
  "سرمایه گذاری ها": "سرمایه گذاری",
  "رایانه و فعالیتهای وابسته به آن": "رایانه",
  "رایانه و فعالیت های وابسته به آن": "رایانه",
  "مخابرات": "مخابرات",
  "بانکها و موسسات اعتباری": "بانک",
  "بانک ها و موسسات اعتباری": "بانک",
  "خودرو و ساخت قطعات": "خودرو",
  "دارو": "دارو",
  "سیمان، آهک و گچ": "سیمان",
  "محصولات غذایی و آشامیدنی به جز قند و شکر": "غذایی",
  "قند و شکر": "قند",
  "منسوجات": "منسوجات",
  "کاشی و سرامیک": "کاشی",
  "لاستیک و پلاستیک": "لاستیک",
  "ماشین آلات و تجهیزات": "ماشین آلات",
  "ماشین آلات و دستگاه های برقی": "برقی",
  "تامین آب، برق و گاز طبیعی": "آب و برق",
  "حمل و نقل، انبارداری و ارتباطات": "حمل و نقل",
  "کشاورزی، دامپروری و شیلات": "کشاورزی",
  "استخراج زغال سنگ": "زغال سنگ",
  "استخراج سایر معادن": "سایر معادن",
  "چاپ و تکثیر": "چاپ",
  "کاغذ و محصولات کاغذی": "کاغذ",
  "شیشه و محصولات شیشه ای": "شیشه",
  "سایر محصولات کانی غیر فلزی": "کانی غیرفلزی",
  "مبلمان و سایر مصنوعات": "مبلمان",
  "پیمانکاری ساختمان": "پیمانکاری",
  "خدمات مهندسی": "خدمات مهندسی",
  "بیمه و صندوق بازنشستگی": "بیمه",
  "بیمه وصندوق بازنشستگی به جز تامین اجتماعی": "بیمه",
  "شرکت های چند رشته ای صنعتی": "چند رشته ای",
  "صندوق سرمایه گذاری قابل معامله": "صندوق ها",
};

/** Normalise Arabic glyphs and spacing so the alias table matches the source. */
export const normalizeIndustryName = (value: string) => value
  .replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, " ")
  .replace(/\s+/g, " ").trim();

/** Short column label; the full source name stays in the cell's title. */
export function shortIndustryName(name: string): string {
  const normalized = normalizeIndustryName(name);
  const alias = NAME_ALIASES[normalized];
  if (alias) return alias;
  const compact = normalized
    .replace(/^صنعت /, "")
    .replace(/،.*$/, "")
    .replace(/\s*\(.*\)$/, "");
  return compact || normalized;
}

// ─── Recorded sessions ──────────────────────────────────────────────────────
/** One recorded session of industry totals, keyed by its market session date. */
export type IndustrySnapshot = { date: number; rows: IndustryRow[] };

const SNAPSHOT_KEY = "ss-industry-snapshots-v3";
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
 * Sums the last `sessions` recorded sessions per industry. Money inflow, traded
 * value and every buy-power component add up; buy power is then recomputed from
 * the summed components, never copied from a single day and never added as a
 * ratio.
 */
export function sumIndustrySessions(snapshots: IndustrySnapshot[], sessions = 3): IndustryRow[] {
  const selected = [...snapshots].sort((a, b) => b.date - a.date).slice(0, Math.max(1, sessions));
  if (!selected.length) return [];
  type Totals = {
    code: string; name: string; net: number | null; value: number | null; symbols: number;
    realBuyValue: number | null; realSellValue: number | null; buyCount: number | null; sellCount: number | null;
  };
  const totals = new Map<string, Totals>();
  const add = (current: number | null, value: number | null) =>
    value === null ? current : (current ?? 0) + value;
  for (const snapshot of selected) {
    for (const row of snapshot.rows) {
      const key = snapshotKeyOf(row);
      const current = totals.get(key) ?? {
        code: row.code, name: row.name, net: null, value: null, symbols: 0,
        realBuyValue: null, realSellValue: null, buyCount: null, sellCount: null,
      };
      current.net = add(current.net, row.net);
      current.value = add(current.value, row.value);
      current.realBuyValue = add(current.realBuyValue, row.realBuyValue);
      current.realSellValue = add(current.realSellValue, row.realSellValue);
      current.buyCount = add(current.buyCount, row.buyCount);
      current.sellCount = add(current.sellCount, row.sellCount);
      current.symbols = Math.max(current.symbols, row.symbols);
      totals.set(key, current);
    }
  }
  return [...totals.values()]
    .map((row) => ({
      ...row,
      buyPower: aggregateBuyPower(row.realBuyValue, row.buyCount, row.realSellValue, row.sellCount),
    }))
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
      return Number.isFinite(date) && date > 0 && rows.length
        ? [{ date, rows: rows.map((row: IndustryRow) => ({
          ...row,
          realBuyValue: numberOrNull(row?.realBuyValue),
          realSellValue: numberOrNull(row?.realSellValue),
          buyCount: numberOrNull(row?.buyCount),
          sellCount: numberOrNull(row?.sellCount),
        })) }]
        : [];
    });
  } catch { return []; }
}

export function writeIndustrySnapshots(snapshots: IndustrySnapshot[]): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshots)); } catch { /* storage is optional */ }
}

/** Sessions already back-filled from history, so a refresh never repeats the sweep. */
const BACKFILL_KEY = "ss-industry-backfill-v2";

/** Sector code → name survives a session where the feed itself is unreachable. */
const SECTOR_NAMES_KEY = "ss-industry-sector-names-v1";

export function readSectorNameCache(): Record<string, string> {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SECTOR_NAMES_KEY) ?? "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, string> : {};
  } catch { return {}; }
}

export function writeSectorNameCache(names: Record<string, string>): void {
  if (typeof window === "undefined" || !Object.keys(names).length) return;
  try { window.localStorage.setItem(SECTOR_NAMES_KEY, JSON.stringify(names)); } catch { /* storage is optional */ }
}

export function readBackfilledSessions(): number[] {
  if (typeof window === "undefined") return [];
  try {
    const parsed = JSON.parse(window.localStorage.getItem(BACKFILL_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.map(Number).filter((value) => Number.isFinite(value) && value > 0) : [];
  } catch { return []; }
}

export function writeBackfilledSessions(sessions: number[]): void {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(BACKFILL_KEY, JSON.stringify([...new Set(sessions)].sort())); } catch { /* storage is optional */ }
}
