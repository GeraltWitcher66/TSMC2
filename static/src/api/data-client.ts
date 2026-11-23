import { withDeadline } from "../../../app/lib/request-lifecycle";
import { dispatchApiPath } from "./router";

/**
 * Static-build counterpart of the shared data client: the same functions the
 * screens call, answered by browser modules instead of a network endpoint.
 */

export function requestData(
  path: string,
  init: RequestInit = {},
  timeoutMs = 20_000,
): Promise<Response> {
  return withDeadline(
    (signal) => dispatchApiPath(path, init, signal),
    timeoutMs,
    init.signal ?? undefined,
  );
}

/** Official TSETMC paths are read straight from the CDN; mirrors rotate in net.ts. */
export function relayUrl(path: string): string {
  return `https://cdn.tsetmc.com/api/${path}`;
}
