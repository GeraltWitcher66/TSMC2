import { screenerRequest } from "./screener";
import { holdersRequest } from "./holders";
import { holderIncreasesRequest } from "./holder-increases";
import { marketHighlightsRequest } from "./market-highlights";
import { marketUniverseRequest } from "./market-universe";
import { marketColorRequest } from "./market-color";
import { jsonResponse } from "./json";

/**
 * The screens ask for a data path; this table answers it with a browser module.
 * No HTTP endpoint is involved, so the build works from a folder, a subpath or
 * a plain file path.
 */
type Handler = (url: URL, init: RequestInit, signal: AbortSignal) => Promise<Response>;

const HANDLERS: Record<string, Partial<Record<string, Handler>>> = {
  screener: { POST: screenerRequest },
  holders: { POST: holdersRequest },
  "holder-increases": { GET: holderIncreasesRequest, POST: holderIncreasesRequest },
  "market-highlights": { POST: marketHighlightsRequest },
  "market-universe": { GET: marketUniverseRequest },
  "market-color": { GET: marketColorRequest },
};

const LOCAL_BASE = "https://local.invalid/";

export function dispatchApiPath(
  pathWithQuery: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  const [name, query = ""] = pathWithQuery.split("?");
  const method = (init.method ?? "GET").toUpperCase();
  const handler = HANDLERS[name]?.[method];
  if (!handler) return Promise.resolve(jsonResponse({ error: "درخواست ناشناخته است." }, 404));
  return handler(new URL(`${name}?${query}`, LOCAL_BASE), init, signal);
}
