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

/**
 * Normalmente `fetch()` falha com TypeError("fetch failed") e coloca o motivo real em `error.cause`.
 */
export function describeFetchError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  const causeLine = summarizeCause(e.cause);
  const base = `${e.name}: ${e.message}`;
  return causeLine ? `${base} | ${causeLine}` : base;
}
