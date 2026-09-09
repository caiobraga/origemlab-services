type FetchInit = RequestInit & { dispatcher?: unknown };

function isCloudflareWorker(): boolean {
  return (
    typeof navigator !== "undefined" &&
    typeof navigator.userAgent === "string" &&
    navigator.userAgent.includes("Cloudflare-Workers")
  );
}

/**
 * Node (ECS/local): Undici with long timeouts.
 * Cloudflare Workers: native fetch — Undici needs MessagePort and breaks on Workers.
 */
export async function ollamaFetch(
  url: string,
  init: FetchInit,
  timeoutMs: number,
): Promise<Response> {
  if (isCloudflareWorker()) {
    const controller = new AbortController();
    const outer = init.signal;
    const onAbort = () => controller.abort();
    if (outer) {
      if (outer.aborted) controller.abort();
      else outer.addEventListener("abort", onAbort, { once: true });
    }
    const t = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { dispatcher: _d, ...rest } = init;
      return await globalThis.fetch(url, { ...rest, signal: controller.signal });
    } finally {
      clearTimeout(t);
      if (outer) outer.removeEventListener("abort", onAbort);
    }
  }

  const { Agent, fetch: undiciFetch } = await import("undici");
  const undiciMs = Math.min(1_800_000, timeoutMs + 30_000);
  const agent = new Agent({
    connectTimeout: Math.min(60_000, undiciMs),
    headersTimeout: undiciMs,
    bodyTimeout: undiciMs,
  });
  return undiciFetch(url, { ...init, dispatcher: agent }) as Promise<Response>;
}
