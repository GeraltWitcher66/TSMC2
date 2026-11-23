/** Validate the source's own Gregorian session, never the refresh clock as a substitute. */
export function sourceSession(value: unknown, now = new Date()): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value), s = String(n);
  if (!Number.isInteger(n) || !/^\d{8}$/.test(s)) return null;
  const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}T00:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10).replaceAll("-", "") !== s) return null;
  const today = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).replaceAll("-", ""));
  return n >= 19000101 && n <= today ? n : null;
}

/** An explicitly zero-volume (or invalid-volume) dated slot is not evidence
 * that a symbol traded on that date. Missing volume remains 'unknown', not
 * falsely classified as zero, for compatibility with older daily feeds. */
export function sourceDailyNoTrade(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const volume = (raw as Record<string, unknown>).volume;
  return volume !== undefined && volume !== null &&
    (!Number.isFinite(Number(volume)) || Number(volume) <= 0);
}

/** A dated daily record must not carry an impossible high/close/low triple.
 * Missing volume is unknown (legacy source), while explicitly zero volume
 * is a known no-trade slot. */
export function validSourceDailyPrice(raw: unknown, now = new Date()): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const row = raw as Record<string, unknown>;
  const date = sourceSession(row.d_even, now);
  const high = Number(row.high), low = Number(row.low), close = Number(row.close);
  return Boolean(date && date <= lastClosedEquitySession(now)) &&
    Number.isFinite(high) && Number.isFinite(low) && Number.isFinite(close) &&
    low > 0 && high >= low && low <= close && close <= high &&
    !sourceDailyNoTrade(row);
}

/** Intraday 'last'/rolling close is not the completed daily closing price.
 * For the screener's daily analytical row, promote a dated instrument
 * snapshot only once its ordinary-equity session has closed. */
export function isClosedScreenerSession(sessionDate: number, now = new Date()): boolean {
  return sourceSession(sessionDate, now) === sessionDate &&
    sessionDate <= lastClosedEquitySession(now);
}
export function instrumentSession(raw?: Record<string, unknown> | null) {
  for (const key of ["Date", "date", "DEven", "dEven"]) {
    const date = sourceSession(raw?.[key]);
    if (date) return date;
  }
  return null;
}

/** A snapshot's date is not proof of a trade when volume is zero or OHLC is
 * contradictory. Only return the date when the quoted close is credible. */
export function validHighlightSnapshotSession(
  raw?: Record<string, unknown> | null, maxSession = lastClosedEquitySession(), now = new Date(),
): number | null {
  const date = instrumentSession(raw);
  if (!date || date > maxSession || !raw || sourceSession(date, now) !== date) return null;
  const close = Number(raw.PriceClose ?? raw.priceClose);
  const volume = Number(raw.Volume ?? raw.volume);
  const yesterday = Number(raw.PriceYesterday ?? raw.priceYesterday);
  if (!Number.isFinite(close) || close <= 0 || !Number.isFinite(volume) || volume <= 0 ||
    !Number.isFinite(yesterday) || yesterday <= 0) return null;
  const rawLow = raw.PriceMin ?? raw.priceMin;
  const rawHigh = raw.PriceMax ?? raw.priceMax;
  const low = rawLow == null ? null : Number(rawLow);
  const high = rawHigh == null ? null : Number(rawHigh);
  if (low !== null && (!Number.isFinite(low) || low <= 0 || low > close)) return null;
  if (high !== null && (!Number.isFinite(high) || high <= 0 || high < close)) return null;
  return date;
}

/** Use a complete dated daily row as a unit, never stamp an undated snapshot by price similarity. */
export function instrumentFromDailyRows(payload: unknown, maxSession = lastClosedEquitySession(), now = new Date()): Record<string, unknown> | null {
  if (!Array.isArray(payload)) return null;
  const rows = payload.filter((r) => r && sourceSession(r.d_even, now) && Number(r.d_even) <= maxSession
    && [r.high, r.low, r.close, r.last, r.open, r.yesterday, r.volume].every((v) => v !== null && v !== "" && Number.isFinite(Number(v)) && Number(v) > 0)
    && Number(r.low) <= Number(r.close) && Number(r.close) <= Number(r.high)
    && r.value !== null && r.value !== undefined && Number.isFinite(Number(r.value)) && Number(r.value) >= 0)
    .sort((a, b) => Number(b.d_even) - Number(a.d_even));
  const r = rows[0];
  return r ? { Date: Number(r.d_even), PriceMax: Number(r.high), PriceMin: Number(r.low), PriceClose: Number(r.close),
    PriceLast: Number(r.last), PriceFirst: Number(r.open), PriceYesterday: Number(r.yesterday), Volume: Number(r.volume), Value: Number(r.value),
    AllowedMin: null, AllowedMinDate: null, NetRealValue: null, BuyPower: 0, quoteSource: "zarvan-daily", delivery: "source" } : null;
}

export function datedClientType(row: Record<string, unknown> | undefined | null, date: number | null | undefined) {
  if (!row || !date || instrumentSession(row) !== date) return null;
  const fields = [["buy_I_Volume", "buyIVolume"], ["sell_I_Volume", "sellIVolume"], ["buy_N_Volume", "buyNVolume"], ["sell_N_Volume", "sellNVolume"]];
  return fields.every((keys) => keys.some((key) => row[key] !== null && row[key] !== undefined && row[key] !== "" && Number.isFinite(Number(row[key])) && Number(row[key]) >= 0)) ? row : null;
}

/** Partial refreshes cannot erase or backdate a previously validated symbol. */
export function preserveHighlightRows<T extends { symbol: string; sessionDate?: number | null; delivery?: string }>(previous: T[], incoming: T[], symbols: string[]) {
  const old = new Map(previous.map((row) => [row.symbol, row]));
  const fresh = new Map(incoming.map((row) => [row.symbol, row]));
  let retained = 0;
  const rows = symbols.flatMap((symbol) => {
    const before = old.get(symbol), after = fresh.get(symbol);
    if (before && (!after || ((before.sessionDate ?? 0) > (after.sessionDate ?? 0)))) {
      retained++;
      return [{ ...before, delivery: "cache" }];
    }
    return after ? [after] : [];
  });
  return { rows, retained };
}

/** Last CLOSED ordinary-equity session (Saturday–Wednesday, 13:00 Tehran).
 * The whole-market holder feed also contains instruments trading on Thursdays
 * (notably some commodity products). Without instrument-level trading evidence,
 * a Thursday slot cannot prove a complete equity session. Iran's exceptional
 * exchange holidays cannot be inferred from weekdays and remain source-unknown.
 */
export function lastClosedEquitySession(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tehran", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
  if (date.getUTCDay() === 4 || date.getUTCDay() === 5 || Number(values.hour) < 13) {
    do { date.setUTCDate(date.getUTCDate() - 1); }
    while (date.getUTCDay() === 4 || date.getUTCDay() === 5);
  }
  return date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
}

/** The same holder slot selection is used by validation, coverage and extraction.
 * Never regard pre-created Thu/Fri slots as proof that ordinary shares traded.
 */
export function selectHolderSession(values: unknown[], now = new Date()) {
  const dates = values.slice(0, 5).map(Number);
  const cutoff = lastClosedEquitySession(now);
  const eligible = (date: number) => sourceSession(date, now) !== null && date <= cutoff &&
    ![4, 5].includes(new Date(`${String(date).slice(0, 4)}-${String(date).slice(4, 6)}-${String(date).slice(6)}T00:00:00Z`).getUTCDay());
  let index = -1;
  for (let i = 0; i < dates.length; i++) {
    if (eligible(dates[i]) && (index < 0 || dates[i] > dates[index])) index = i;
  }
  let previousIndex = -1;
  for (let i = 0; i < index; i++) {
    if (eligible(dates[i]) && dates[i] < dates[index] && (previousIndex < 0 || dates[i] > dates[previousIndex])) previousIndex = i;
  }
  const sourceDate = index < 0 ? null : dates[index];
  // A later source slot may be pre-created or belong to a Thursday-only
  // instrument. Its existence makes a negative/zero for the chosen slot unknown.
  const completeForSelectedSession = previousIndex >= 0 && index === dates.length - 1 && previousIndex === index - 1;
  return { sourceDate, index, previousIndex, completeForSelectedSession };
}

/** A feed filtered for its final (possibly future) snapshot cannot prove zero changes in an earlier session. */
export function holderSessionCoverage(payload: unknown, now = new Date()) {
  const raw = (payload as { dates?: unknown[] } | null)?.dates;
  const chosen = selectHolderSession(Array.isArray(raw) ? raw : [], now);
  return { sourceDate: chosen.sourceDate, completeForSelectedSession: chosen.completeForSelectedSession };
}

/** A dated partial source must not lose to the older bundled snapshot merely because it is partial. */
export function preferHolderSource(server: { sourceDate: number | null; fallback?: boolean; partial?: boolean; rows: unknown[] } | undefined,
  direct: { sourceDate: number; partial?: boolean; rows: unknown[] }) {
  return !server?.sourceDate || (direct.sourceDate >= server.sourceDate &&
    (server.fallback || !direct.partial || (server.partial && direct.rows.length >= server.rows.length)));
}
