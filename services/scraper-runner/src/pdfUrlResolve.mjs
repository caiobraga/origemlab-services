/**
 * Normaliza e reescreve URLs de PDF (ex.: FINEP migrou /images para legacy.finep.gov.br).
 */

export function normalizePdfUrl(url) {
  let u = String(url || "").trim();
  if (!u) return u;
  try {
    u = decodeURIComponent(u);
  } catch {
    // ignore
  }
  return u.replace(/%20+$/i, "").trim();
}

/**
 * URL efetiva para download. www.finep.gov.br/images/* → legacy.finep.gov.br (HTTP 200).
 */
export function resolvePdfFetchUrl(url) {
  const u = normalizePdfUrl(url);
  if (!u) return u;
  try {
    const parsed = new URL(u);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    if (host === "finep.gov.br" || host === "download.finep.gov.br") {
      if (/\/images\//i.test(parsed.pathname)) {
        return `https://legacy.finep.gov.br${parsed.pathname}${parsed.search}`;
      }
    }
  } catch {
    // keep original
  }
  return u;
}
