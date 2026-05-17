function summarizeCause(cause) {
  if (!cause) return "";
  if (cause instanceof Error) {
    const extra = cause.code ? ` code=${cause.code}` : "";
    const syscall = cause.syscall ? ` syscall=${cause.syscall}` : "";
    const host = cause.hostname ? ` host=${cause.hostname}` : "";
    return `${cause.name}: ${cause.message}${extra}${syscall}${host}`;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return String(cause);
  }
}

export function describeFetchError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  const causeLine = summarizeCause(e.cause);
  const base = `${e.name}: ${e.message}`;
  return causeLine ? `${base} | ${causeLine}` : base;
}

export function isTransientFetchError(err) {
  if (err instanceof Error && err.name === "AbortError") return false;
  const msg = describeFetchError(err).toLowerCase();
  return /fetch failed|econnreset|econnrefused|etimedout|enotfound|socket hang up|network|und_err_connect_timeout/i.test(msg);
}
