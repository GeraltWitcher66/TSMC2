import {
  marketHighlightFromInstrument,
  normalizeSymbol,
  toApiSymbol,
  type MarketHighlight,
} from "../../lib/market";
import { datedCurrentQuotes } from "../../lib/current-quotes";
import { officialDetails, HIGHLIGHT_BATCH_SIZE } from "../../lib/official-details";
import { upstreamJson, type UpstreamDiagnostic } from "../../lib/upstream";
import { inferSnapshotSession, instrumentFromDailyRows, instrumentSession, validHighlightSnapshotSession, datedClientType } from "../../lib/market-session";
import { highlightCoverage } from "../../lib/data-coverage";
import { expectedHighlightSession } from "../../lib/highlight-session";

const DATA_BASE = "https://zarvanfund.ir/api";
const TSETMC_CLIENT_TYPE_ALL = "https://cdn.tsetmc.com/api/ClientType/GetClientTypeAll";
const TSETMC_HEADERS = {
  Accept: "application/json",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36",
  Referer: "https://tsetmc.com/",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
};

const chunks = <T,>(items: T[], size: number) => {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
};

async function fetchClientTypes(observe: (event: UpstreamDiagnostic) => void) {
    const payload = await upstreamJson<{ clientTypeAllDto: Record<string, unknown>[] }>(TSETMC_CLIENT_TYPE_ALL, {
      timeoutMs: 6_000, headers: TSETMC_HEADERS, observe,
      validate: (value) => Array.isArray((value as { clientTypeAllDto?: unknown } | null)?.clientTypeAllDto),
    });
    const rows = Array.isArray(payload.clientTypeAllDto) ? payload.clientTypeAllDto : [];
    return new Map(rows.flatMap((row) => {
      const insCode = String(row.insCode ?? row.InsCode ?? "").trim();
      return insCode ? [[insCode, row] as const] : [];
    }));
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as { symbols?: string[]; pricesOnly?: boolean } | null;
    if (!Array.isArray(body?.symbols) || body.symbols.length > HIGHLIGHT_BATCH_SIZE || body.symbols.some((symbol) => typeof symbol !== "string")) return Response.json({ error: `در هر درخواست حداکثر ${HIGHLIGHT_BATCH_SIZE} نماد معتبر مجاز است.` }, { status: 400 });
    const symbols = Array.from(new Set(body.symbols.map(normalizeSymbol).filter(Boolean)));
    if (!symbols.length) return Response.json({ error: "حداقل یک نماد لازم است." }, { status: 400 });

    const requested = new Set(symbols);
    const rows: MarketHighlight[] = [];
    const sessionDates: number[] = [];
    const priceIssues = new Map<string, string>();
    let failedBatches = 0;
    let clientTypeUnavailable = false;
    const diagnostics: UpstreamDiagnostic[] = [];
    const observe = (event: UpstreamDiagnostic) => { diagnostics.push(event); };
    const clientTypesPromise = body.pricesOnly === true ? Promise.resolve(new Map<string, Record<string, unknown>>()) : fetchClientTypes(observe).catch(() => {
      clientTypeUnavailable = true;
      return new Map<string, Record<string, unknown>>();
    });
    for (const part of chunks(symbols.map(toApiSymbol), 100)) {
      try {
        const payload = await upstreamJson<Record<string, Record<string, unknown>>>(
          `${DATA_BASE}/instruments?syms=${encodeURIComponent(part.join(","))}&_=${Date.now()}`,
          {
            timeoutMs: 12_000, signal: request.signal, observe,
            headers: { Accept: "application/json", "Cache-Control": "no-cache", Pragma: "no-cache" },
            validate: (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)),
          },
        );
        const instruments = new Map(Object.entries(payload).filter(([key, value]) => requested.has(normalizeSymbol(key)) && value && typeof value === "object"));
        for (const symbol of symbols) if (![...instruments.keys()].some(key => normalizeSymbol(key) === symbol)) priceIssues.set(symbol, "instrument_missing_in_response");
        // Existing dated daily feed is independent of the undated instruments snapshot.
        const dailyPromise = upstreamJson<Record<string, unknown>>(`${DATA_BASE}/daily-batch?limit=2&syms=${encodeURIComponent(part.join(","))}`, {
            timeoutMs: 8_000, signal: request.signal, observe,
            validate: (value) => Boolean(value && typeof value === "object" && !Array.isArray(value)),
          }).catch(() => ({} as Record<string, unknown>));
        const [quotes, daily] = await Promise.all([body.pricesOnly === true ? Promise.resolve(new Map<string, Record<string, unknown>>()) : datedCurrentQuotes(instruments, observe), dailyPromise]);
        const clientTypes = await clientTypesPromise;
        const dailyBySymbol = new Map(Object.entries(daily).map(([key, value]) => [normalizeSymbol(key), value]));
        for (const [key, original] of instruments) {
          const official = quotes.get(key);
          const maxSession = expectedHighlightSession(String(original.Name ?? original.name ?? key));
          const datedDaily = instrumentFromDailyRows(dailyBySymbol.get(normalizeSymbol(key)), maxSession);
          const originalDate = validHighlightSnapshotSession(original, maxSession);
          const inferredDate = originalDate ? null : inferSnapshotSession(original, dailyBySymbol.get(normalizeSymbol(key)), maxSession);
          const snapshotDate = originalDate ?? inferredDate;
          const noTradeToday = !instrumentSession(original) && !snapshotDate && Boolean(datedDaily) && Number(datedDaily!.Date) < maxSession;
          const replacement = official && Number(official.Date) >= (snapshotDate ?? 0) && Number(official.Date) >= Number(datedDaily?.Date ?? 0)
            ? official : datedDaily && Number(datedDaily.Date) > (snapshotDate ?? 0) ? datedDaily : !snapshotDate ? datedDaily : null;
          // Undated real-money/floor fields must not travel with a dated replacement quote.
          const base: Record<string, unknown> = {
            ...original,
            ...(snapshotDate ? (inferredDate ? { Date: inferredDate, AllowedMin: null, AllowedMinDate: null, NetRealValue: null, BuyPower: 0 } : {})
              : { Date: null, date: null, DEven: null, dEven: null }),
            ...(noTradeToday ? { noTradeToday: true } : {}),
            quoteSource: "zarvan-instruments", quoteFetchedAt: new Date().toISOString(), delivery: "source",
          };
          const raw: Record<string, unknown> = replacement ? { ...base, ...(snapshotDate !== Number(replacement.Date) ? { AllowedMin: null, AllowedMinDate: null, NetRealValue: null, BuyPower: 0 } : {}), ...replacement } : base;
          const dataDate = instrumentSession(raw);
          priceIssues.set(normalizeSymbol(key), !dataDate ? "date_unverified" : "price_record_invalid");
          const insCode = String(raw.InsCode ?? raw.insCode ?? raw.ins_code ?? "").trim();
          const parsed = dataDate ? marketHighlightFromInstrument(
            { ...raw, Symbol: raw.Symbol ?? key },
            datedClientType(clientTypes.get(insCode), dataDate),
          ) : null;
          if (parsed && requested.has(parsed.symbol)) {
            rows.push(parsed);
            if (parsed.sessionDate) sessionDates.push(parsed.sessionDate);
          }
        }
      } catch {
        // A failed upstream batch is reported as partial data. Other batches
        // still render, so one problematic group cannot blank the whole page.
        failedBatches += 1;
      }
    }

    if (!rows.length && failedBatches > 0) throw new Error("منبع معاملات برای هیچ‌کدام از دسته‌ها پاسخ معتبر نداد");

    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    const baseRows = symbols.flatMap((symbol) => bySymbol.get(symbol) ? [bySymbol.get(symbol)!] : []);
    const orderedRows = body.pricesOnly === true ? baseRows : await officialDetails(baseRows, observe, request.signal);
    clientTypeUnavailable = orderedRows.some((row) => !row.clientTypeAvailable);
    return Response.json(
      {
        rows: orderedRows,
        latestDate: sessionDates.length ? Math.max(...sessionDates) : null,
        partial: failedBatches > 0 || orderedRows.length < symbols.length || (body.pricesOnly !== true && clientTypeUnavailable),
        failedBatches,
        clientTypeUnavailable,
        missingCount: Math.max(0, symbols.length - orderedRows.length),
        fetchedAt: new Date().toISOString(),
        diagnostics,
        coverage: highlightCoverage(orderedRows, symbols.length),
        outcomes: symbols.map(symbol => { const row = bySymbol.get(symbol); return { symbol, insCode: row?.insCode ?? null, date: row?.sessionDate ?? null,
          price: row?.sessionDate ? "received" : failedBatches ? "request_failed" : priceIssues.get(symbol) ?? "missing_or_invalid_source_record" }; }),
      },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate", Pragma: "no-cache", Expires: "0" } },
    );
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "دریافت اطلاعات معاملات بیش از حد طول کشید؛ دوباره تلاش کن."
      : `دریافت فیلترهای معاملات ناموفق بود${error instanceof Error ? ` (${error.message})` : ""}.`;
    return Response.json({ error: message }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
