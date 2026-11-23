import {
  isClosedTehranDailyCandle,
  mergeCandlesByDate,
  subtractCalendarDays,
  type Candle,
  type ShareChange,
} from "./market";

export type UpstreamAvailability = "complete" | "partial" | "unavailable";
export type CanonicalSource = "tsetmc" | "zarvan" | "mixed" | "none";
export type DataQualityState = "ready" | "degraded" | "unavailable";

export type CandleSeriesInspection = {
  inputCount: number;
  validCount: number;
  invalidCount: number;
  duplicateDates: number;
  conflictingDuplicateDates: number;
  firstDate: number | null;
  lastDate: number | null;
  maxGapDays: number | null;
};

export type DataProvenance = {
  source: CanonicalSource;
  sourceHistory: string[];
  latestSession: number | null;
  historyStart: number | null;
  historyEnd: number | null;
  candleCount: number;
  isComplete: boolean;
  isFallback: boolean;
  capitalActionSource: "tsetmc" | "unavailable";
  adjustmentComplete: boolean;
  quality: DataQualityState;
  inputInvalidDates: number;
  inputDuplicateDates: number;
  conflictingDuplicateDates: number;
  maxGapDays: number | null;
  warnings: string[];
};

export type CanonicalHistory = {
  candles: Candle[];
  changes: ShareChange[];
  provenance: DataProvenance;
};

export type CanonicalHistoryInput = {
  tsetmcCandles?: Candle[];
  zarvanCandles?: Candle[];
  shareChanges?: ShareChange[];
  tsetmcHistoryStatus: UpstreamAvailability;
  capitalActionStatus: UpstreamAvailability;
  sourceHistory?: string[];
  expectedLatestSession?: number | null;
  minimumCandles?: number;
  lookbackDays?: number;
  now?: Date;
  warnings?: string[];
};

const dateFromCompact = (value: number) => {
  const text = String(value);
  return new Date(Date.UTC(Number(text.slice(0, 4)), Number(text.slice(4, 6)) - 1, Number(text.slice(6, 8))));
};

const validCandle = (candle: Candle) => Number.isInteger(candle.d_even)
  && candle.d_even >= 19000101
  && candle.d_even <= 29991231
  && Number.isFinite(candle.high)
  && Number.isFinite(candle.low ?? candle.close)
  && Number.isFinite(candle.close)
  && candle.high > 0
  && (candle.low ?? candle.close) > 0
  && candle.close > 0;

const candleSignature = (candle: Candle) => [
  candle.high,
  candle.low ?? null,
  candle.close,
  candle.open ?? null,
  candle.last ?? null,
  candle.yesterday ?? null,
].join(":");

export function inspectCandleSeries(candles: Candle[]): CandleSeriesInspection {
  const valid = candles.filter(validCandle);
  const signatures = new Map<number, string>();
  let duplicates = 0;
  let conflicts = 0;
  for (const candle of valid) {
    const signature = candleSignature(candle);
    const previous = signatures.get(candle.d_even);
    if (previous !== undefined) {
      duplicates += 1;
      if (previous !== signature) conflicts += 1;
    }
    signatures.set(candle.d_even, signature);
  }

  const dates = [...signatures.keys()].sort((a, b) => a - b);
  let maxGapDays: number | null = null;
  for (let index = 1; index < dates.length; index += 1) {
    const gap = Math.round((dateFromCompact(dates[index]).getTime() - dateFromCompact(dates[index - 1]).getTime()) / 86_400_000);
    maxGapDays = maxGapDays === null ? gap : Math.max(maxGapDays, gap);
  }
  return {
    inputCount: candles.length,
    validCount: dates.length,
    invalidCount: candles.length - valid.length,
    duplicateDates: duplicates,
    conflictingDuplicateDates: conflicts,
    firstDate: dates[0] ?? null,
    lastDate: dates.at(-1) ?? null,
    maxGapDays,
  };
}

function normalizeCandles(candles: Candle[]) {
  return mergeCandlesByDate(candles.filter(validCandle), []);
}

/**
 * Build one deterministic candle series for all calculations. TSETMC wins on
 * duplicate dates, while Zarvan may fill dates TSETMC did not return. The
 * merged result is only indicator-safe when the official history and
 * corporate-action lookups both completed successfully.
 */
export function buildCanonicalHistory(input: CanonicalHistoryInput): CanonicalHistory {
  const tsetmcInput = input.tsetmcCandles ?? [];
  const zarvanInput = input.zarvanCandles ?? [];
  const tsetmcInspection = inspectCandleSeries(tsetmcInput);
  const zarvanInspection = inspectCandleSeries(zarvanInput);
  const tsetmc = normalizeCandles(tsetmcInput);
  const zarvan = normalizeCandles(zarvanInput);
  const candles = mergeCandlesByDate(tsetmc, zarvan);
  const normalizedInspection = inspectCandleSeries(candles);
  const warnings = [...(input.warnings ?? [])];
  const minimumCandles = Math.max(30, input.minimumCandles ?? 80);
  const lookbackDays = Math.max(30, input.lookbackDays ?? 90);
  const now = input.now ?? new Date();

  const source: CanonicalSource = tsetmc.length && zarvan.length
    ? "mixed"
    : tsetmc.length ? "tsetmc" : zarvan.length ? "zarvan" : "none";

  if (input.tsetmcHistoryStatus === "unavailable") warnings.push("tsetmc-history-unavailable");
  if (input.tsetmcHistoryStatus === "partial") warnings.push("tsetmc-history-partial");
  if (input.capitalActionStatus !== "complete") warnings.push("capital-actions-unavailable");
  if (tsetmcInspection.invalidCount + zarvanInspection.invalidCount > 0) warnings.push("invalid-candles-removed");
  if (tsetmcInspection.duplicateDates + zarvanInspection.duplicateDates > 0) warnings.push("duplicate-dates-normalized");
  if (tsetmcInspection.conflictingDuplicateDates + zarvanInspection.conflictingDuplicateDates > 0) warnings.push("conflicting-duplicate-dates");

  const officialCoverageRequired = Math.min(minimumCandles, zarvan.length || minimumCandles);
  if (input.tsetmcHistoryStatus === "complete" && tsetmc.length < officialCoverageRequired) {
    warnings.push("tsetmc-history-insufficient-coverage");
  }

  const latestSession = normalizedInspection.lastDate;
  if (input.expectedLatestSession && (!latestSession || latestSession < input.expectedLatestSession)) {
    warnings.push("latest-session-missing");
  }

  const closed = candles
    .filter((candle) => isClosedTehranDailyCandle(candle.d_even, now))
    .sort((a, b) => a.d_even - b.d_even);
  if (closed.length < minimumCandles) warnings.push("insufficient-closed-candles");
  if (closed.length) {
    const cutoff = subtractCalendarDays(closed.at(-1)!.d_even, lookbackDays);
    if (closed.filter((candle) => candle.d_even >= cutoff).length < 15) warnings.push("insufficient-lookback-candles");
  }

  const blockingWarnings = new Set([
    "tsetmc-history-unavailable",
    "tsetmc-history-partial",
    "capital-actions-unavailable",
    "conflicting-duplicate-dates",
    "tsetmc-history-insufficient-coverage",
    "latest-session-missing",
    "insufficient-closed-candles",
    "insufficient-lookback-candles",
  ]);
  const quality: DataQualityState = !candles.length
    ? "unavailable"
    : warnings.some((warning) => blockingWarnings.has(warning)) ? "degraded" : "ready";

  return {
    candles,
    changes: input.capitalActionStatus === "complete" ? (input.shareChanges ?? []) : [],
    provenance: {
      source,
      sourceHistory: [...new Set(input.sourceHistory ?? [])],
      latestSession,
      historyStart: normalizedInspection.firstDate,
      historyEnd: normalizedInspection.lastDate,
      candleCount: candles.length,
      isComplete: quality === "ready",
      isFallback: input.tsetmcHistoryStatus !== "complete",
      capitalActionSource: input.capitalActionStatus === "complete" ? "tsetmc" : "unavailable",
      adjustmentComplete: input.capitalActionStatus === "complete",
      quality,
      inputInvalidDates: tsetmcInspection.invalidCount + zarvanInspection.invalidCount,
      inputDuplicateDates: tsetmcInspection.duplicateDates + zarvanInspection.duplicateDates,
      conflictingDuplicateDates: tsetmcInspection.conflictingDuplicateDates + zarvanInspection.conflictingDuplicateDates,
      maxGapDays: normalizedInspection.maxGapDays,
      warnings: [...new Set(warnings)],
    },
  };
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) }, worker));
  return results;
}

export class RequestCoalescer<T> {
  private readonly recent = new Map<string, { expiresAt: number; value: T }>();
  private readonly running = new Map<string, Promise<T>>();

  constructor(private readonly ttlMs: number, private readonly maxEntries = 12) {}

  async run(key: string, task: () => Promise<T>, now = Date.now()): Promise<T> {
    const cached = this.recent.get(key);
    if (cached && cached.expiresAt > now) return cached.value;
    const active = this.running.get(key);
    if (active) return active;
    const promise = task().then((value) => {
      this.recent.set(key, { expiresAt: Date.now() + this.ttlMs, value });
      while (this.recent.size > this.maxEntries) this.recent.delete(this.recent.keys().next().value!);
      return value;
    }).finally(() => this.running.delete(key));
    this.running.set(key, promise);
    return promise;
  }

  clear() {
    this.recent.clear();
    this.running.clear();
  }
}

export type LastKnownGoodSnapshot<T> = {
  value: T;
  sourceDate: number | null;
  fetchedAt: string;
  recordCount: number;
  complete: true;
};

export class LastKnownGoodStore<T> {
  private snapshot: LastKnownGoodSnapshot<T> | null = null;

  replace(candidate: LastKnownGoodSnapshot<T> | (Omit<LastKnownGoodSnapshot<T>, "complete"> & { complete: boolean })) {
    if (!candidate.complete) return false;
    this.snapshot = { ...candidate, complete: true };
    return true;
  }

  get() {
    return this.snapshot;
  }

  clear() {
    this.snapshot = null;
  }
}

export const shouldCacheHolderSnapshot = (payload: {
  rows?: unknown[];
  sourceDate?: number | null;
  partial?: boolean;
  error?: unknown;
}) => Array.isArray(payload.rows)
  && !payload.partial
  && !payload.error
  && Number.isInteger(payload.sourceDate)
  && Number(payload.sourceDate) >= 19000101;
