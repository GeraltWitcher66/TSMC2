import { normalizeSymbol, toApiSymbol } from "../../../app/lib/market";
import { fetchWithTimeout } from "../../../app/lib/request-lifecycle";
import { countMajorIndividualHolders } from "../../../app/lib/major-individual-count";
import { jsonResponse, readJsonBody } from "./json";

const DATA_BASE = "https://zarvanfund.ir/api";

export async function holdersRequest(
  _url: URL,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  try {
    const body = await readJsonBody<{ symbols?: string[] }>(init);
    const invalid = !Array.isArray(body?.symbols) || body.symbols.length > 10 || body.symbols.some((symbol) => {
      if (typeof symbol !== "string" || symbol.length > 64) return true;
      if (!symbol.trim()) return false;
      const normalized = normalizeSymbol(symbol);
      return !normalized || /^\d+$/.test(normalized);
    });
    if (invalid) return jsonResponse({ error: "حداکثر ۱۰ نماد معتبر لازم است." }, 400);
    const symbols = Array.from(new Set((body.symbols ?? []).map(normalizeSymbol).filter(Boolean))).slice(0, 10);
    if (!symbols.length) return jsonResponse({ counts: {} });

    const entries = await Promise.all(symbols.map(async (symbol) => {
      try {
        const response = await fetchWithTimeout(`${DATA_BASE}/shareholders?symbol=${encodeURIComponent(toApiSymbol(symbol))}`, {
          signal,
        }, 12_000);
        if (!response.ok) throw new Error(String(response.status));
        const data = await response.json() as unknown;
        // A failed or malformed upstream body is "unavailable" (null), never a
        // fake zero: the UI renders "—" instead of a wrong count.
        const result = countMajorIndividualHolders(data);
        return [symbol, result] as const;
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "TimeoutError" || /timeout|مهلت/i.test(error.message));
        return [symbol, { count: null, sourceDate: null, status: timedOut ? "timeout" as const : "failed" as const }] as const;
      }
    }));
    return jsonResponse({
      counts: Object.fromEntries(entries.map(([symbol, result]) => [symbol, result.count])),
      outcomes: Object.fromEntries(entries),
      partial: entries.some(([, result]) => result.count === null),
    });
  } catch {
    return jsonResponse({ error: "شمارش سهامداران عمده انجام نشد." }, 502);
  }
}
