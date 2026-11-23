/** Response helpers shared by the in-browser data handlers. */

export function jsonResponse(
  payload: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    },
  });
}

/** Request bodies arrive as text; a malformed body is a client error, not a crash. */
export async function readJsonBody<T>(init: RequestInit): Promise<T | null> {
  const body = init.body;
  if (typeof body !== "string" || !body.trim()) return null;
  try {
    return JSON.parse(body) as T;
  } catch {
    return null;
  }
}

export const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
};
