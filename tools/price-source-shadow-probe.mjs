/**
 * One-symbol read-only shadow pilot. No Worker deployment, API keys,
 * paid endpoints, automated polling, database mutation or broad market scans.
 *
 * Usage (Windows):
 *   node --import ./tests/register-typescript.mjs tools/price-source-shadow-probe.mjs --symbol=خودرو --provider=webgw --probe
 *   node --import ./tests/register-typescript.mjs tools/price-source-shadow-probe.mjs --symbol=خودرو --provider=cdn --probe
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { normalizeSymbol, toApiSymbol } from "../app/lib/market.ts";
import {
  comparePriceSources, fromTseWebgwHistory, fromTsetmcCurrent,
  fromZarvanDaily, priceIdentity,
} from "../app/lib/price-source-shadow.ts";

const cli = Object.fromEntries(process.argv.slice(2).filter((s) => s.startsWith("--") && s.includes("="))
  .map((s) => s.slice(2).split(/=(.*)/s).slice(0, 2)));
const enabled = process.argv.includes("--probe");
const symbol = normalizeSymbol(cli.symbol ?? "");
const provider = cli.provider ?? "webgw";
if (!enabled || !symbol || symbol.length > 32 || !["webgw", "cdn"].includes(provider)) {
  console.error("Read-only pilot requires --probe --symbol=<one Persian symbol> --provider=webgw|cdn");
  process.exitCode = 2;
} else {
  const maxBytes = 2_000_000;
  const checks = [];
  const time = () => new Date().toISOString();
  const read = async (url, label, timeoutMs) => {
    const startedAt = time();
    const start = Date.now();
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    let status = null, contentType = null, bytes = 0;
    try {
      const response = await fetch(url, {
        method: "GET", signal: controller.signal, redirect: "manual",
        headers: { Accept: "application/json", "Cache-Control": "no-cache" },
      });
      status = response.status;
      contentType = response.headers.get("content-type");
      if (!response.ok || !contentType?.includes("json")) throw Error(!response.ok ? "HTTP_NON_2XX" : "NON_JSON_RESPONSE");
      const reader = response.body?.getReader();
      if (!reader) throw Error("BODY_MISSING");
      const chunks = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw Error("BODY_OVER_2MB_CAP"); }
        chunks.push(value);
      }
      const combined = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
      const data = JSON.parse(new TextDecoder().decode(combined));
      checks.push({ label, status, contentType, bytes, startedAt, elapsedMs: Date.now() - start, outcome: "ok" });
      return data;
    } catch (error) {
      const outcome = controller.signal.aborted ? "timeout" : error instanceof SyntaxError ? "invalid-json" : String(error?.message ?? "network-error");
      checks.push({ label, status, contentType, bytes, startedAt, elapsedMs: Date.now() - start, outcome });
      return null;
    } finally { clearTimeout(deadline); }
  };

  const encoded = encodeURIComponent(toApiSymbol(symbol));
  // For each single requested symbol, use source-provided identifiers, never
  // guess the ISIN from InsCode or lose a 17-digit code to JS number.
  const instrumentMap = await read(`https://zarvanfund.ir/api/instruments?syms=${encoded}`, "zarvan-identity", 7_000);
  const normalizedMap = Object.fromEntries(Object.entries(instrumentMap ?? {}).map(([s, data]) => [normalizeSymbol(s), data]));
  const identity = priceIdentity(normalizedMap[symbol], symbol);
  let base = null, alternative = null;
  if (identity) {
    const dailyMap = await read(`https://zarvanfund.ir/api/daily-batch?limit=5&syms=${encoded}`, "zarvan-daily", 7_000);
    const dailyRows = Object.entries(dailyMap ?? {}).find(([s]) => normalizeSymbol(s) === symbol)?.[1];
    base = fromZarvanDaily(identity, dailyRows);
    // No retries, no parallel fanout, and NO paid APIs. The archive may be
    // large; response-body guard prevents a single symbol from exhausting RAM.
    if (provider === "webgw" && identity.isin) {
      const payload = await read(`https://webgw.tse.ir/InstrumentProvider/api/v1/History/Archive/fa?InstrumentId=${encodeURIComponent(identity.isin)}`, "webgw-history", 7_000);
      alternative = fromTseWebgwHistory(identity, payload);
    } else if (provider === "cdn") {
      const payload = await read(`https://cdn.tsetmc.com/api/ClosingPrice/GetClosingPriceInfo/${encodeURIComponent(identity.insCode)}`, "tsetmc-cdn-current", 7_000);
      alternative = fromTsetmcCurrent(identity, payload);
    }
  }
  const comparison = comparePriceSources(base, alternative);
  const report = {
    createdAt: time(), mode: "read-only-shadow-probe", provider, symbol,
    sourceVerified: Boolean(base), alternateVerified: Boolean(alternative),
    identity: identity ? { symbol: identity.symbol, insCode: identity.insCode, isin: identity.isin } : null,
    base: base && { source: base.source, sessionDate: base.sessionDate, closeRial: base.closeRial, volume: base.volume },
    alternate: alternative && { source: alternative.source, sessionDate: alternative.sessionDate, closeRial: alternative.closeRial, volume: alternative.volume },
    comparison: comparison.status,
    deltaRial: "deltaRial" in comparison ? comparison.deltaRial : null,
    daysAhead: "daysAhead" in comparison ? comparison.daysAhead : null,
    checks,
    limitations: [
      "This is one-symbol local egress, NOT Cloudflare Worker egress.",
      "No change to app prices or adjustment-based 90/180/RSI computations.",
      "A newer external session does not prove a provider's adjustment basis or a tradable security's status.",
      "CDN community API is not the newly licensed TSETMC RestAPI announced at api.tsetmc.com/docs.",
    ],
  };
  await mkdir(resolve("work"), { recursive: true });
  const output = resolve("work", `price-source-shadow-${provider}-20261024.json`);
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ report: output, comparison: report.comparison, base: report.base,
    alternate: report.alternate, checks: report.checks }, null, 2));
}
