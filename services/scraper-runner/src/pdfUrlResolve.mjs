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
  return u
    .replace(/%20+$/i, "")
    .replace(/(\.pdf)\/view(?:[?#].*)?$/i, "$1")
    .trim();
}

function parseIpv4(hostname) {
  const m = String(hostname || "")
    .trim()
    .match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const parts = m.slice(1).map((x) => Number(x));
  if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 255)) return null;
  return parts;
}

/** Hosts que o ECS/AWS não alcança (rede privada / loopback). */
export function isUnroutablePdfHost(hostname) {
  const host = String(hostname || "").trim().toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".local")) return true;
  const ip = parseIpv4(host);
  if (!ip) return false;
  const [a, b] = ip;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 169 && b === 254) return true;
  return false;
}

/**
 * URL efetiva para download. Reescreve hosts legados/internos quando o path público é conhecido.
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

    // FAPEPI: páginas antigas apontam wp-content para IP interno (10.10.10.206); o path existe no site público.
    const fapepiLegacyHost = parsed.hostname === "10.10.10.206";
    const fapepiPublicHost = host === "fapepi.pi.gov.br";
    if ((fapepiLegacyHost || fapepiPublicHost) && /\/wp-content\/uploads\//i.test(parsed.pathname)) {
      return `https://www.fapepi.pi.gov.br${parsed.pathname}${parsed.search}`;
    }
  } catch {
    // keep original
  }
  return u;
}

export function assertPdfUrlRoutable(url) {
  const fetchUrl = resolvePdfFetchUrl(url);
  let host = "";
  try {
    host = new URL(fetchUrl).hostname;
  } catch {
    throw new Error(`PDF fetch skipped: URL inválida (${String(url || "").slice(0, 120)})`);
  }
  if (isUnroutablePdfHost(host)) {
    throw new Error(`PDF fetch skipped: host não roteável (${host})`);
  }
  return fetchUrl;
}
