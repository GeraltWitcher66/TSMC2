import { fetchWithTimeout } from "../../lib/request-lifecycle";
import { INDUSTRY_SOURCE_URL, parseIndustries, type IndustryRow } from "../../lib/industry";

const CACHE_TTL_MS = 5 * 60 * 1000;

let cache: { at: number; rows: IndustryRow[] } | null = null;
let inFlight: Promise<IndustryRow[]> | null = null;

async function loadIndustries(signal: AbortSignal) {
  const response = await fetchWithTimeout(INDUSTRY_SOURCE_URL, {
    headers: { Accept: "application/json", "Cache-Control": "no-cache" }, signal,
  }, 12_000);
  if (!response.ok) throw new Error(`فهرست صنایع HTTP ${response.status} برگرداند.`);
  return parseIndustries(await response.json());
}

/** Whole-market industry aggregates, cached briefly per isolate. */
export async function GET() {
  let rows = cache && Date.now() - cache.at < CACHE_TTL_MS ? cache.rows : null;
  let stale = false;
  if (!rows) {
    try {
      inFlight ??= loadIndustries(AbortSignal.timeout(20_000));
      rows = await inFlight;
      cache = { at: Date.now(), rows };
    } catch {
      // A failed refresh may still serve the previous snapshot, clearly labelled.
      rows = cache?.rows ?? null;
      stale = Boolean(rows);
    } finally {
      inFlight = null;
    }
  }
  if (!rows) {
    return Response.json({ error: "جمع ورود پول صنعت‌ها از منبع دریافت نشد." }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
  return Response.json({
    industries: rows, stale, partial: stale,
    fetchedAt: new Date(cache?.at ?? Date.now()).toISOString(),
  }, { headers: { "Cache-Control": "no-store" } });
}
