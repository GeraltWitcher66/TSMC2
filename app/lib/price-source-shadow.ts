import { normalizeSymbol } from "./market";
import { lastClosedEquitySession, sourceSession } from "./market-session";

/**
 * Shadow-only source adapters for comparing provider observations.
 *
 * This module deliberately does not modify the screener's price/history,
 * valuations, RSI or divergence. A newer quote from a second source is NOT
 * evidence that two providers use a compatible adjustment basis.
 */
export type PriceSource = "zarvan-daily" | "tsetmc-cdn" | "tse-webgw-history";
export type PriceIdentity = { symbol: string; insCode: string; isin: string | null };
export type PriceObservation = {
  identity: PriceIdentity;
  source: PriceSource;
  sessionDate: number;
  closeRial: number;
  highRial: number;
  lowRial: number;
  openRial: number | null;
  lastRial: number | null;
  volume: number;
  retrievedAt: string;
  // Adjusted and unadjusted series must never be spliced indiscriminately.
  adjustmentBasis: "unadjusted" | "unknown";
};
export type PriceComparison =
  | { status: "unavailable"; base: PriceObservation | null; alternative: PriceObservation | null; reason: string }
  | { status: "different-instrument"; base: PriceObservation; alternative: PriceObservation; reason: string }
  | { status: "same-date-match"; base: PriceObservation; alternative: PriceObservation; deltaRial: 0 }
  | { status: "same-date-close-match-ohlc-conflict"; base: PriceObservation; alternative: PriceObservation; deltaRial: 0; reason: string }
  | { status: "same-date-conflict"; base: PriceObservation; alternative: PriceObservation; deltaRial: number }
  | { status: "alternative-newer"; base: PriceObservation; alternative: PriceObservation; daysAhead: number }
  | { status: "base-newer"; base: PriceObservation; alternative: PriceObservation; daysAhead: number };

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | null =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject : null;

const integer = (value: unknown, allowZero = false): number | null => {
  // Community WebGW docs describe {value,state}, but state semantics have
  // NOT been verified against a live sample. Accept only explicit valid
  // states in shadow fixtures; fail closed on unknown numeric/status flags.
  const wrapper = object(value);
  if (wrapper) {
    const state = wrapper.state;
    if (state !== undefined && state !== "ok" && state !== "valid") return null;
    value = wrapper.value;
  }
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && (allowZero ? parsed >= 0 : parsed > 0) ? parsed : null;
};

export function priceIdentity(raw: unknown, expectedSymbol: string): PriceIdentity | null {
  const instrument = object(raw);
  const symbol = normalizeSymbol(expectedSymbol);
  if (!instrument || !symbol) return null;
  const providedSymbol = instrument.Symbol ?? instrument.symbol;
  if (typeof providedSymbol === "string" && normalizeSymbol(providedSymbol) !== symbol) return null;
  const rawCode = instrument.InsCode ?? instrument.insCode ?? instrument.ins_code;
  if (typeof rawCode !== "string" && !(typeof rawCode === "number" && Number.isSafeInteger(rawCode))) return null;
  const insCode = String(rawCode);
  // InsCode is a 17-digit identifier, not a safely representable JS number.
  if (!/^\d{1,20}$/.test(insCode)) return null;
  const rawIsin = instrument.ISIN ?? instrument.Isin ?? instrument.isin ?? instrument.CIsin ?? instrument.cIsin;
  const isin = typeof rawIsin === "string" && /^IR[A-Z0-9]{10}$/.test(rawIsin.trim().toUpperCase())
    ? rawIsin.trim().toUpperCase() : null;
  return { symbol, insCode, isin };
}

const observation = (
  identity: PriceIdentity,
  source: PriceSource,
  fields: { date: unknown; close: unknown; high: unknown; low: unknown; open?: unknown; last?: unknown; volume: unknown },
  now: Date,
): PriceObservation | null => {
  const sessionDate = sourceSession(fields.date, now);
  const closeRial = integer(fields.close), highRial = integer(fields.high),
    lowRial = integer(fields.low), volume = integer(fields.volume);
  // Never compare an intraday/pre-created slot as a finalized daily close.
  if (!sessionDate || sessionDate > lastClosedEquitySession(now) ||
      closeRial === null || highRial === null || lowRial === null ||
      volume === null || lowRial > closeRial || closeRial > highRial) return null;
  const openRial = integer(fields.open), lastRial = integer(fields.last);
  if ((openRial !== null && (openRial < lowRial || openRial > highRial)) ||
      (lastRial !== null && (lastRial < lowRial || lastRial > highRial))) return null;
  return { identity, source, sessionDate, closeRial, highRial, lowRial, openRial,
    lastRial, volume, retrievedAt: now.toISOString(), adjustmentBasis: "unknown" };
};

/** Select a source-dated traded Zarvan daily candle; do not use Date=0 snapshots. */
export function fromZarvanDaily(identity: PriceIdentity, rows: unknown, now = new Date()): PriceObservation | null {
  if (!Array.isArray(rows)) return null;
  let selected: PriceObservation | null = null;
  for (const raw of rows) {
    const r = object(raw);
    if (!r) continue;
    const candidate = observation(identity, "zarvan-daily", {
      date: r.d_even, close: r.close, high: r.high, low: r.low,
      open: r.open, last: r.last, volume: r.volume,
    }, now);
    if (candidate && (!selected || candidate.sessionDate > selected.sessionDate)) selected = candidate;
  }
  return selected;
}

/** Existing community-documented CDN endpoint, not the new licensed REST API. */
export function fromTsetmcCurrent(identity: PriceIdentity, payload: unknown, now = new Date()): PriceObservation | null {
  const row = object(object(payload)?.closingPriceInfo);
  if (!row) return null;
  const code = row.insCode;
  if (typeof code === "number" && !Number.isSafeInteger(code)) return null;
  if (code !== undefined && code !== null && String(code) !== "0" && String(code) !== identity.insCode) return null;
  return observation(identity, "tsetmc-cdn", {
    date: row.dEven, close: row.pClosing, high: row.priceMax, low: row.priceMin,
    open: row.priceFirst, last: row.pDrCotVal, volume: row.qTotTran5J,
  }, now);
}

/** Parse the unofficially documented TSE gateway history shape, ISIN-bound. */
export function fromTseWebgwHistory(identity: PriceIdentity, payload: unknown, now = new Date()): PriceObservation | null {
  if (!identity.isin) return null;
  const root = object(payload);
  const rows = Array.isArray(payload) ? payload
    : Array.isArray(root?.items) ? root.items
    : Array.isArray(root?.Items) ? root.Items : null;
  if (!rows) return null;
  let selected: PriceObservation | null = null;
  for (const raw of rows) {
    const r = object(raw);
    if (!r) continue;
    const claimedIsin = r.instrumentid ?? r.instrumentId ?? r.InstrumentId ?? r.isin ?? r.ISIN;
    // Without an echoed instrument ID, this is not a verified response for
    // the requested ISIN. An HTTP200 archive alone cannot prove identity.
    if (typeof claimedIsin !== "string" || claimedIsin.trim().toUpperCase() !== identity.isin) continue;
    const candidate = observation(identity, "tse-webgw-history", {
      date: r.devenrlc, close: r.closingprice, high: r.highvalue, low: r.lowvalue,
      open: r.firstPrice, last: r.lastprice, volume: r.tradevolume,
    }, now);
    if (candidate && (!selected || candidate.sessionDate > selected.sessionDate)) selected = candidate;
  }
  return selected;
}

const toDate = (compact: number) => new Date(Date.UTC(Math.floor(compact / 10000), Math.floor(compact / 100) % 100 - 1, compact % 100));
export function comparePriceSources(base: PriceObservation | null, alternative: PriceObservation | null): PriceComparison {
  if (!base || !alternative) return { status: "unavailable", base, alternative, reason: "At least one provider has no valid traded and dated observation." };
  if (base.identity.insCode !== alternative.identity.insCode ||
      base.identity.symbol !== alternative.identity.symbol ||
      (base.identity.isin && alternative.identity.isin && base.identity.isin !== alternative.identity.isin)) {
    return { status: "different-instrument", base, alternative, reason: "InsCode, symbol or ISIN disagree." };
  }
  if (base.sessionDate === alternative.sessionDate) {
    const deltaRial = alternative.closeRial - base.closeRial;
    if (deltaRial !== 0) return { status: "same-date-conflict", base, alternative, deltaRial };
    if (base.lowRial !== alternative.lowRial || base.highRial !== alternative.highRial ||
        base.volume !== alternative.volume)
      return { status: "same-date-close-match-ohlc-conflict", base, alternative,
        deltaRial: 0, reason: "Closing prices match but same-session high, low or volume does not." };
    return { status: "same-date-match", base, alternative, deltaRial: 0 };
  }
  const daysAhead = Math.round(Math.abs(toDate(alternative.sessionDate).getTime() - toDate(base.sessionDate).getTime()) / 86_400_000);
  return alternative.sessionDate > base.sessionDate
    ? { status: "alternative-newer", base, alternative, daysAhead }
    : { status: "base-newer", base, alternative, daysAhead };
}
