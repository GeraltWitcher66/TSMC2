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

/**
 * The fallback for a read-only official path: the alternate official host.
 * There is no same-origin relay in a static build, and the primary host has
 * already been tried by the caller.
 */
export function relayUrl(path: string): string {
  return `https://tsetmc.com/api/${path}`;
}
