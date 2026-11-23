/** Bound the entire operation, including response bodies and uncooperative transports. */
export async function withDeadline<T>(task: (signal: AbortSignal) => Promise<T>, ms: number, parent?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  let rejectAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const abort = () => {
    controller.abort(parent?.reason ?? new DOMException("عملیات لغو شد.", "AbortError"));
    rejectAbort(controller.signal.reason);
  };
  const timer = setTimeout(() => {
    controller.abort(new DOMException("مهلت دریافت داده تمام شد؛ دوباره تلاش کنید.", "TimeoutError"));
    rejectAbort(controller.signal.reason);
  }, ms);
  parent?.addEventListener("abort", abort, { once: true });
  try {
    if (parent?.aborted) abort();
    return await Promise.race([aborted, Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return task(controller.signal);
    })]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", abort);
  }
}

/** Buffer the body before releasing the timer; fetch alone only waits for headers. */
export function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, ms = 15_000, request: typeof fetch = fetch): Promise<Response> {
  return withDeadline(async (signal) => {
    const response = await request(input, { ...init, signal });
    const body = await response.arrayBuffer();
    return new Response([101, 204, 205, 304].includes(response.status) ? null : body, {
      status: response.status, statusText: response.statusText, headers: response.headers,
    });
  }, ms, init.signal ?? undefined);
}

export async function readApiJson<T>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw.trim()) throw new Error(`سرور پاسخ خالی داد (HTTP ${response.status}).`);
  try { return JSON.parse(raw) as T; }
  catch { throw new Error(`پاسخ سرور قابل پردازش نبود (HTTP ${response.status}).`); }
}

/** Two workers, two attempts, one total budget; completed batches survive expiry. */
export async function loadBatches<T>(batches: string[][], load: (batch: string[], signal: AbortSignal, attempt: number) => Promise<T>, options: {
  signal?: AbortSignal; budgetMs?: number; attemptMs?: number; retryMs?: number;
  concurrency?: number; pauseMs?: number;
  onSuccess?: (batch: string[], value: T) => void;
} = {}) {
  const results: { batch: string[]; data: T | null; error: string | null }[] = [];
  let cursor = 0;
  let expired = false;
  try {
    await withDeadline(async (signal) => {
      const worker = async () => {
        while (!signal.aborted && cursor < batches.length) {
          const batch = batches[cursor++];
          let error = "دریافت ناموفق بود.";
          for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
            try {
              const data = await withDeadline((attemptSignal) => load(batch, attemptSignal, attempt), options.attemptMs ?? 55_000, signal);
              signal.throwIfAborted();
              results.push({ batch, data, error: null });
              options.onSuccess?.(batch, data);
              break;
            } catch (err) {
              error = err instanceof Error ? err.message : error;
              if (attempt === 1 || signal.aborted) results.push({ batch, data: null, error });
              else await withDeadline(() => new Promise<void>((resolve) => setTimeout(resolve, options.retryMs ?? 700)), 2_000, signal);
            }
          }
          if ((options.pauseMs ?? 0) > 0 && !signal.aborted && cursor < batches.length) {
            await withDeadline(() => new Promise<void>((resolve) => setTimeout(resolve, options.pauseMs)), options.pauseMs! + 500, signal);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(2, Math.floor(options.concurrency ?? 2))) }, () => worker()));
    }, options.budgetMs ?? 120_000, options.signal);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    expired = true;
  }
  if (expired) for (const batch of batches) {
    if (!results.some(result => result.batch === batch)) results.push({ batch, data: null, error: "مهلت کل دریافت تمام شد؛ این دسته کامل دریافت نشد." });
  }
  return { results: [...results], expired };
}
