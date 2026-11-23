import { normalizeSymbol, type ScreenerRow } from "./market";
import type { ScreenerVerificationState } from "./screener-refresh";

export type ScreenerCacheEntry = {
  /** Session the snapshot belongs to. */
  session: number;
  savedAt: number;
  verification?: ScreenerVerificationState | null;
  rows: ScreenerRow[];
};

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "length" | "key">;

const indexKey = (source: string) => `ss-screener-index-v1:${source}`;
const entryKey = (source: string, signature: string, session: number) => `ss-screener-v1:${source}:${session}:${signature}`;

/** Stable, short identity of the symbol list so a changed list never reuses a snapshot. */
export function screenerSymbolsSignature(symbols: string[]) {
  const normalized = symbols.map((symbol) => normalizeSymbol(symbol)).join("|");
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${symbols.length}-${(hash >>> 0).toString(36)}`;
}

export function readScreenerCache(storage: StorageLike | null | undefined, source: string, symbols: string[]): ScreenerCacheEntry | null {
  if (!storage || !symbols.length) return null;
  try {
    const index = JSON.parse(storage.getItem(indexKey(source)) ?? "null") as { signature?: string; session?: number } | null;
    if (!index || index.signature !== screenerSymbolsSignature(symbols) || !index.session) return null;
    const raw = storage.getItem(entryKey(source, index.signature, index.session));
    if (!raw) return null;
    const entry = JSON.parse(raw) as ScreenerCacheEntry;
    if (entry.session !== index.session || !Array.isArray(entry.rows) || !entry.rows.length) return null;
    return entry;
  } catch { return null; }
}

/**
 * Store the snapshot for a reload of the same list and session. Candles are the
 * bulk of a row and only serve a live verification pass, so the stored copy is
 * the display snapshot; the next start re-reads the source only when needed.
 */
export function writeScreenerCache(
  storage: StorageLike | null | undefined, source: string, symbols: string[], entry: ScreenerCacheEntry,
): boolean {
  if (!storage || !symbols.length || !entry.session || !entry.rows.length) return false;
  try {
    const signature = screenerSymbolsSignature(symbols);
    const current = entryKey(source, signature, entry.session);
    const rows = entry.rows.map((row) => {
      const copy = { ...row };
      delete copy.analysisInput;
      return copy;
    });
    storage.setItem(current, JSON.stringify({ ...entry, rows }));
    storage.setItem(indexKey(source), JSON.stringify({ signature, session: entry.session }));
    const prefix = `ss-screener-v1:${source}:`;
    const stale: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key && key.startsWith(prefix) && key !== current) stale.push(key);
    }
    for (const key of stale) storage.removeItem(key);
    return true;
  } catch {
    // A full or disabled storage only means the next start reloads the source.
    return false;
  }
}
