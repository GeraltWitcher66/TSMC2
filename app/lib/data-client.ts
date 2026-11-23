import { fetchWithTimeout } from "./request-lifecycle";

/**
 * Every market-data read of the UI goes through this module. Keeping the
 * endpoint names here lets the same screens run either against the deployed
 * routes or entirely inside the browser, without touching analysis code.
 */
export function requestData(
  path: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  return fetchWithTimeout(`/api/${path}`, init, timeoutMs);
}

/** Read-only official relay, used when the direct CDN request fails. */
export function relayUrl(path: string): string {
  return `/api/tsetmc-relay?path=${encodeURIComponent(path)}`;
}
