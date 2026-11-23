import { reportNetworkFailure, reportNetworkSuccess } from "./connection";

/**
 * One policy for every request that leaves the page.
 *
 * Market endpoints answer plain CORS requests, but only when the request looks
 * like a plain CORS request: browser-forbidden headers (User-Agent, Referer,
 * Cache-Control, Pragma) are dropped so no preflight is created, a timestamp
 * parameter defeats intermediate caches, and at most six requests run at once
 * so the data hosts do not throttle the page.
 */

const MAX_CONCURRENT_UPSTREAM = 6;

// Only CORS-safelisted request headers survive; anything else is dropped.
const ALLOWED_REQUEST_HEADERS = new Set(["accept", "accept-language"]);

// The official CDN and its mirror serve the same read-only paths.
const OFFICIAL_MIRROR: Record<string, string> = {
  "cdn.tsetmc.com": "tsetmc.com",
  "tsetmc.com": "cdn.tsetmc.com",
};

let installed = false;
let activeRequests = 0;
const waiting: Array<() => void> = [];

function acquireSlot(): Promise<void> {
  if (activeRequests < MAX_CONCURRENT_UPSTREAM) {
    activeRequests += 1;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    waiting.push(() => {
      activeRequests += 1;
      resolve();
    });
  });
}

function releaseSlot() {
  activeRequests = Math.max(0, activeRequests - 1);
  const next = waiting.shift();
  if (next) next();
}

function safeHeaders(input?: HeadersInit): Headers {
  const result = new Headers();
  if (!input) return result;
  new Headers(input).forEach((value, name) => {
    if (ALLOWED_REQUEST_HEADERS.has(name.toLowerCase())) result.set(name, value);
  });
  return result;
}

function withTimestamp(url: URL): URL {
  const next = new URL(url.toString());
  if (!next.searchParams.has("_")) next.searchParams.set("_", String(Date.now()));
  return next;
}

function mirrorOf(url: URL): URL | null {
  const mirror = OFFICIAL_MIRROR[url.hostname];
  if (!mirror) return null;
  const next = new URL(url.toString());
  next.hostname = mirror;
  return next;
}

export function installNetworkPolicy() {
  if (installed) return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const rawUrl = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : request
          ? request.url
          : String(input);

    let target: URL;
    try {
      target = new URL(rawUrl, document.baseURI);
    } catch {
      return nativeFetch(input, init);
    }
    if (target.protocol !== "http:" && target.protocol !== "https:") return nativeFetch(input, init);
    if (target.origin === window.location.origin) return nativeFetch(input, init);

    const method = (init.method ?? request?.method ?? "GET").toUpperCase();
    const signal = init.signal ?? request?.signal ?? undefined;
    const headers = safeHeaders(init.headers ?? request?.headers);

    const attempt = async (url: URL) => {
      await acquireSlot();
      try {
        return await nativeFetch(url.toString(), {
          ...init,
          method,
          headers,
          signal,
          credentials: "omit",
        });
      } finally {
        releaseSlot();
      }
    };

    try {
      const response = await attempt(withTimestamp(target));
      if (method === "GET" && response.status >= 500) {
        const mirror = mirrorOf(target);
        if (mirror) {
          try {
            const alternate = await attempt(withTimestamp(mirror));
            if (alternate.ok) {
              reportNetworkSuccess();
              return alternate;
            }
          } catch {
            // The original response still describes the failure.
          }
        }
      }
      if (response.ok) reportNetworkSuccess();
      else reportNetworkFailure();
      return response;
    } catch (error) {
      if (signal?.aborted) throw error;
      const mirror = method === "GET" ? mirrorOf(target) : null;
      if (mirror) {
        try {
          const alternate = await attempt(withTimestamp(mirror));
          if (alternate.ok) {
            reportNetworkSuccess();
            return alternate;
          }
        } catch {
          // Fall through to the original transport error.
        }
      }
      reportNetworkFailure();
      throw error;
    }
  };
}
