import { fetchWithScraperAgent } from "./fetchAgent.mjs";
import { BNDES_HUBS, scrapeBndesChamadas } from "./bndesCore.mjs";

/**
 * Env (opcionais):
 *   BNDES_HUB_URLS     CSV — substitui as páginas hub padrão (`BNDES_HUBS` em bndesCore.mjs)
 *   BNDES_EXTRA_URLS   CSV — páginas de chamada extras (ex.: https://www.bndes.gov.br/riodoceparticipativo)
 *   BNDES_MAX_DETAIL   máx. de páginas de detalhe (default 60)
 */
function csvEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

async function fetchText(url, timeoutMs = 60000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetchWithScraperAgent(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return await r.text();
  } finally {
    clearTimeout(t);
  }
}

export async function scrapeBndesCurrentYear() {
  const hubs = csvEnv("BNDES_HUB_URLS");
  return scrapeBndesChamadas({
    fetchText,
    hubs: hubs.length ? hubs : BNDES_HUBS,
    extraUrls: csvEnv("BNDES_EXTRA_URLS"),
    maxDetail: Number(process.env.BNDES_MAX_DETAIL || "60") || 60,
    log: (msg) => console.log(`[scraper-runner] bndes: ${msg}`),
  });
}
