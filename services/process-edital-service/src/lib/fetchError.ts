function summarizeCause(cause: unknown): string {
  if (!cause) return "";
  if (cause instanceof Error) {
    const c = cause as Error & { code?: string; syscall?: string; hostname?: string };
    const extra = c.code ? ` code=${c.code}` : "";
    const syscall = c.syscall ? ` syscall=${c.syscall}` : "";
    const host = c.hostname ? ` host=${c.hostname}` : "";
    return `${c.name}: ${c.message}${extra}${syscall}${host}`;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

/** `fetch failed` do undici — motivo real costuma estar em `error.cause`. */
export function describeFetchError(err: unknown): string {
  const e = err instanceof Error ? err : new Error(String(err));
  const causeLine = summarizeCause((e as Error & { cause?: unknown }).cause);
  const base = `${e.name}: ${e.message}`;
  return causeLine ? `${base} | ${causeLine}` : base;
}

export function isOllamaServerCrash(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    /segmentation fault|llama-server process has terminated|llama runner process has terminated|memory layout cannot be allocated|runner terminated|exit status 2/i.test(
      msg,
    ) || /ollama error 5\d\d/i.test(msg)
  );
}

export function isTransientFetchError(err: unknown): boolean {
  if (err instanceof Error && err.name === "AbortError") return false;
  if (isOllamaServerCrash(err)) return true;
  const msg = describeFetchError(err).toLowerCase();
  return /fetch failed|econnreset|econnrefused|etimedout|enotfound|socket hang up|network|und_err_connect_timeout|und_err_headers_timeout|headerstimeouterror/i.test(
    msg,
  );
}
