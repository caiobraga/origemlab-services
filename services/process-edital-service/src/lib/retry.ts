import { isOllamaServerCrash, isTransientFetchError } from "./fetchError";

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    label: string;
    attempts?: number;
    baseDelayMs?: number;
    onRetry?: (err: unknown, attempt: number) => Promise<void>;
  },
): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const baseDelayMs = Math.max(200, opts.baseDelayMs ?? 1500);
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i >= attempts - 1 || !isTransientFetchError(e)) throw e;
      if (opts.onRetry) await opts.onRetry(e, i + 1);
      const delay = isOllamaServerCrash(e) ? 15_000 * (i + 1) : baseDelayMs * (i + 1);
      console.warn(`⚠️ ${opts.label}: tentativa ${i + 1}/${attempts} falhou — retry em ${delay}ms (${e instanceof Error ? e.message : String(e)})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last;
}
