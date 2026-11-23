import { fetchWithTimeout, withDeadline } from "../../../app/lib/request-lifecycle";
import { normalizeSymbol } from "../../../app/lib/market";
import { jsonResponse } from "./json";

const DATA_BASE = "https://zarvanfund.ir/api";

type Sector = { sector_code?: string; sector_name?: string };
type MarketSymbol = { symbol?: string; name?: string; market?: string };
type InstrumentData = {
  Symbol?: string;
  Name?: string;
  PriceYesterday?: number;
  PriceMax?: number;
  PriceMin?: number;
  PriceClose?: number;
  PriceLast?: number;
  AllowedMax?: number;
  AllowedMin?: number;
  Volume?: number;
  Value?: number;
  TradeCount?: number;
  BestAsk?: number;
  BestBid?: number;
  Orderbook?: unknown[];
  GroupCode?: number;
  SectorCode?: string;
  SectorName?: string;
  InsCode?: string;
};

type ColorSymbol = {
  symbol: string;
  name: string;
  market: string;
  color: "yellow" | "orange";
  insCode: string;
  priceYesterday: number;
  priceMax: number;
  priceMin: number;
  priceClose: number;
  priceLast: number;
  volume: number;
  value: number;
  tradeCount: number;
  changePct: number;
};

const EXCLUDED_SECTORS = new Set(["68"]);

// Tolerance for classification: 2.8-3.2% = yellow, 1.8-2.2% = orange
const YELLOW_MIN = 2.7;
const YELLOW_MAX = 3.3;
const ORANGE_MIN = 1.7;
const ORANGE_MAX = 2.3;

function classifyByPriceLimit(priceYesterday: number, priceMax: number): "yellow" | "orange" | null {
  if (priceYesterday <= 0 || priceMax <= 0) return null;
  const pct = ((priceMax - priceYesterday) / priceYesterday) * 100;
  if (pct >= YELLOW_MIN && pct <= YELLOW_MAX) return "yellow";
  if (pct >= ORANGE_MIN && pct <= ORANGE_MAX) return "orange";
  return null;
}

function isExcludedSymbol(symbol: string): boolean {
  const s = normalizeSymbol(symbol);
  // Exclude right-of-precedence (ends with ح)
  if (s.endsWith("ح")) return true;
  // Exclude digits-only endings (typically ETFs, bonds, etc.)
  if (/\d+$/.test(s)) return true;
  return false;
}

export async function marketColorRequest(
  url: URL,
  init: RequestInit,
  _signal: AbortSignal,
): Promise<Response> {
  try {
    return await withDeadline(async (signal) => {
      let failed = 0;
      const boundedFetch = (address: string, options: RequestInit = {}) => fetchWithTimeout(address, { ...options, signal }, 8_000);
      const color = url.searchParams.get("color"); // "yellow" or "orange" or null (both)

      // 1. Get all sectors
      const sectorResponse = await boundedFetch(`${DATA_BASE}/sectors`);
      if (!sectorResponse.ok) throw new Error(`sectors ${sectorResponse.status}`);
      const sectors = (await sectorResponse.json()) as Sector[];
      if (!Array.isArray(sectors) || !sectors.length || sectors.length > 200) throw new Error("فهرست صنایع معتبر نیست.");
      const codes = sectors
        .map((item) => String(item.sector_code ?? "").trim())
        .filter((code) => code && !EXCLUDED_SECTORS.has(code));

      // 2. Get all symbols from all sectors
      const universe = new Map<string, { symbol: string; name: string; market: string }>();
      for (let index = 0; index < codes.length; index += 6) {
        if (signal.aborted) { failed++; break; }
        const part = codes.slice(index, index + 6);
        const responses = await Promise.all(
          part.flatMap((code) =>
            ["bourse", "farabourse"].map(async (market) => {
              const address = `${DATA_BASE}/sector-symbols?code=${encodeURIComponent(code)}&market=${market}&limit=1000`;
              try {
                const response = await boundedFetch(address);
                if (!response.ok) throw new Error("منبع پاسخ نداد.");
                const rows = await response.json();
                if (!Array.isArray(rows)) throw new Error("ساختار نمادها معتبر نیست.");
                return rows as MarketSymbol[];
              } catch {
                failed++; return [];
              }
            })
          )
        );
        for (const rows of responses) {
          for (const item of rows) {
            const symbol = normalizeSymbol(String(item.symbol ?? ""));
            if (!symbol || isExcludedSymbol(symbol)) continue;
            universe.set(symbol, {
              symbol,
              name: String(item.name ?? ""),
              market: String(item.market ?? ""),
            });
          }
        }
      }

      // 3. Get price data for all symbols in batches
      const allSymbols = [...universe.values()];
      const BATCH_SIZE = 100;
      const classified: ColorSymbol[] = [];

      for (let i = 0; i < allSymbols.length; i += BATCH_SIZE) {
        if (signal.aborted) { failed++; break; }
        const batch = allSymbols.slice(i, i + BATCH_SIZE);
        const apiSymbols = batch.map((item) =>
          item.symbol.replace(/ک/g, "ك").replace(/ی/g, "ي")
        );

        try {
          const instrumentUrl = `${DATA_BASE}/instruments?syms=${encodeURIComponent(apiSymbols.join(","))}`;
          const instrumentResponse = await boundedFetch(instrumentUrl);

          if (!instrumentResponse.ok) throw new Error("دریافت قیمت ناموفق بود.");
          if (instrumentResponse.ok) {
            const instruments = (await instrumentResponse.json()) as Record<string, InstrumentData>;

            for (const item of batch) {
              const normalizedKey = normalizeSymbol(item.symbol);
              // Find the instrument data - zarvan returns with Arabic kaf
              const arabicKey = normalizedKey.replace(/ک/g, "ك").replace(/ی/g, "ي");
              const data = instruments[arabicKey] || instruments[normalizedKey];

              if (!data) continue;

              const py = Number(data.PriceYesterday ?? 0);
              const pm = Number(data.PriceMax ?? 0);
              const colorType = classifyByPriceLimit(py, pm);

              if (!colorType) continue;
              if (color && color !== colorType) continue;

              const pc = Number(data.PriceClose ?? 0);
              const pl = Number(data.PriceLast ?? 0);
              const vol = Number(data.Volume ?? 0);
              const val = Number(data.Value ?? 0);
              const tc = Number(data.TradeCount ?? 0);

              classified.push({
                symbol: item.symbol,
                name: item.name,
                market: item.market,
                color: colorType,
                insCode: String(data.InsCode ?? ""),
                priceYesterday: py,
                priceMax: pm,
                priceMin: Number(data.PriceMin ?? 0),
                priceClose: pc,
                priceLast: pl,
                volume: vol,
                value: val,
                tradeCount: tc,
                changePct: py > 0 ? Math.round(((pc - py) / py) * 10000) / 100 : 0,
              });
            }
          }
        } catch {
          failed++;
          // Skip failed batches
        }
      }

      if (!allSymbols.length || (!classified.length && failed)) throw new Error("دریافت داده بازار کامل نشد.");
      // Sort by symbol
      classified.sort((a, b) => a.symbol.localeCompare(b.symbol, "fa"));

      return jsonResponse(
        {
          partial: failed > 0,
          symbols: classified,
          total: classified.length,
          yellowCount: classified.filter((s) => s.color === "yellow").length,
          orangeCount: classified.filter((s) => s.color === "orange").length,
          fetchedAt: new Date().toISOString(),
        },
      );
    }, 40_000, init.signal ?? undefined);
  } catch (error) {
    return jsonResponse(
      { error: `دریافت داده بازار رنگی ناموفق بود: ${error instanceof Error ? error.message : "خطای ناشناخته"}` },
      502,
    );
  }
}
