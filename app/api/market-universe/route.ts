import { fetchWithTimeout } from "../../lib/request-lifecycle";
import { normalizeSymbol } from "../../lib/market";

const DATA_BASE = "https://zarvanfund.ir/api";
const EXCLUDED_SECTORS = new Set(["68"]);

type Sector = { sector_code?: string; sector_name?: string };
type MarketSymbol = { symbol?: string; name?: string; market?: string };
type Market = "bourse" | "farabourse";
type SectorRequest = { sectorCode: string; market: Market };
type SectorResult = { request: SectorRequest; rows: MarketSymbol[]; failure?: string; retryable?: boolean; attempts: number };
type UniverseSymbol = { symbol: string; name: string; market: string; marketProvenance: "sector-request" | "ambiguous" };

const MARKETS: Market[] = ["bourse", "farabourse"];

export async function GET(request?: Request) {
  const deadline = AbortSignal.timeout(40_000);
  const signal = request ? AbortSignal.any([request.signal, deadline]) : deadline;
  const boundedFetch = (url: string, init: RequestInit = {}) => fetchWithTimeout(url, { ...init, signal }, 8_000);
  try {
    const sectorResponse = await boundedFetch(`${DATA_BASE}/sectors`, { headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
    if (!sectorResponse.ok) throw new Error(String(sectorResponse.status));
    const sectors = await sectorResponse.json() as Sector[];
    if (!Array.isArray(sectors) || !sectors.length || sectors.length > 200) throw new Error("فهرست صنایع معتبر نیست.");
    const codes = [...new Set(sectors
      .map((item) => String(item.sector_code ?? "").trim())
      .filter((code) => code && !EXCLUDED_SECTORS.has(code)))];
    const requests: SectorRequest[] = codes.flatMap((sectorCode) => MARKETS.map((market) => ({ sectorCode, market })));
    const fetchSector = async (task: SectorRequest): Promise<SectorResult> => {
      const url = `${DATA_BASE}/sector-symbols?code=${encodeURIComponent(task.sectorCode)}&market=${task.market}&limit=1000`;
      try {
        const response = await boundedFetch(url, { headers: { Accept: "application/json", "Cache-Control": "no-cache" } });
        if (!response.ok) return { request: task, rows: [], failure: `http-${response.status}`, retryable: response.status >= 500 || response.status === 429, attempts: 1 };
        const rows = await response.json();
        if (!Array.isArray(rows)) return { request: task, rows: [], failure: "invalid-shape", attempts: 1 };
        return { request: task, rows: rows as MarketSymbol[], attempts: 1 };
      } catch (error) {
        const reason = signal.aborted ? "deadline-or-cancelled" : error instanceof Error && error.name === "TimeoutError" ? "timeout" : "network";
        return { request: task, rows: [], failure: reason, retryable: !signal.aborted, attempts: 1 };
      }
    };
    const results: SectorResult[] = [];
    for (let index = 0; index < requests.length; index += 12) {
      const part = requests.slice(index, index + 12);
      if (signal.aborted) {
        results.push(...requests.slice(index).map((task) => ({ request: task, rows: [], failure: "deadline-or-cancelled", attempts: 0 })));
        break;
      }
      results.push(...await Promise.all(part.map(fetchSector)));
    }
    // A single targeted retry can recover transient failures without repeating
    // successful sector requests or exceeding the overall request deadline.
    let retriedRequests = 0;
    for (let index = 0; index < results.length; index += 12) {
      if (signal.aborted) break;
      const selected = results.slice(index, index + 12);
      const transient = selected.filter((result) => result.failure && result.retryable);
      if (!transient.length) continue;
      const retried = await Promise.all(transient.map((result) => fetchSector(result.request)));
      for (let i = 0; i < transient.length; i++) {
        const original = transient[i];
        results[results.indexOf(original)] = { ...retried[i], attempts: original.attempts + retried[i].attempts };
        retriedRequests++;
      }
    }

    const universe = new Map<string, UniverseSymbol>();
    const ambiguous = new Set<string>();
    for (const result of results) {
      for (const item of result.rows) {
        const symbol = normalizeSymbol(String(item.symbol ?? ""));
        if (!symbol || symbol.endsWith("ح") || /\d$/.test(symbol)) continue;
        const declared = String(item.market ?? "").trim().toLowerCase();
        const inconsistent = MARKETS.some((market) => market === declared) && declared !== result.request.market;
        const previous = universe.get(symbol);
        const conflicting = inconsistent || ambiguous.has(symbol) || Boolean(previous?.market && previous.market !== result.request.market);
        if (conflicting) ambiguous.add(symbol);
        universe.set(symbol, {
          symbol, name: String(item.name ?? "") || previous?.name || "",
          market: conflicting ? "" : result.request.market,
          marketProvenance: conflicting ? "ambiguous" : "sector-request",
        });
      }
    }

    const failures = results.filter((result) => result.failure).map((result) => ({
      sectorCode: result.request.sectorCode, market: result.request.market,
      reason: result.failure, attempts: result.attempts,
    }));
    const failedByMarket = Object.fromEntries(MARKETS.map((market) => [market, failures.filter((f) => f.market === market).length]));
    const failedBySector = Object.fromEntries(codes.flatMap((code) => {
      const count = failures.filter((failure) => failure.sectorCode === code).length;
      return count ? [[code, count]] : [];
    }));
    const diagnostics = { requestedEndpoints: requests.length, failedCount: failures.length,
      failedByMarket, failedBySector, failures, retriedRequests, conflictingMarketsCount: ambiguous.size };
    if (!universe.size) return Response.json({
      error: "فهرست نمادهای بورس و فرابورس دریافت نشد.", partial: true, fetchedAt: new Date().toISOString(), diagnostics,
    }, { status: 502, headers: { "Cache-Control": "no-store" } });
    return Response.json({
      partial: failures.length > 0 || ambiguous.size > 0, fetchedAt: new Date().toISOString(),
      symbols: [...universe.values()].sort((a, b) => a.symbol.localeCompare(b.symbol, "fa")),
      diagnostics,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "فهرست نمادهای بورس و فرابورس دریافت نشد." }, { status: 502 });
  }
}
