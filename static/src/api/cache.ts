/**
 * Two-level cache that replaces the previous edge cache: a short-lived memory
 * map plus a persistent localStorage copy. Every entry is keyed by content
 * identity and carries its own expiry, so a stale entry is never served.
 */

const PREFIX = "screener-cache:";

type Entry = { expiresAt: number; value: string };

const memory = new Map<string, Entry>();

function storage(): Storage | null {
  try {
    const target = window.localStorage;
    const probe = `${PREFIX}probe`;
    target.setItem(probe, "1");
    target.removeItem(probe);
    return target;
  } catch {
    return null;
  }
}

export function readCache(key: string): string | null {
  const now = Date.now();
  const cached = memory.get(key);
  if (cached && cached.expiresAt > now) return cached.value;
  if (cached) memory.delete(key);

  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(PREFIX + key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as Entry;
    if (!entry || typeof entry.value !== "string" || typeof entry.expiresAt !== "number") return null;
    if (entry.expiresAt <= now) {
      store.removeItem(PREFIX + key);
      return null;
    }
    memory.set(key, entry);
    return entry.value;
  } catch {
    return null;
  }
}

export function writeCache(key: string, value: string, ttlMs: number): void {
  if (!(ttlMs > 0) || !value) return;
  const entry: Entry = { expiresAt: Date.now() + ttlMs, value };
  memory.set(key, entry);
  const store = storage();
  if (!store) return;
  try {
    store.setItem(PREFIX + key, JSON.stringify(entry));
  } catch {
    // A full or disabled storage only costs the persistent copy.
  }
}

export function dropCache(key: string): void {
  memory.delete(key);
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(PREFIX + key);
  } catch {
    // Ignore a storage that refused the removal.
  }
}
