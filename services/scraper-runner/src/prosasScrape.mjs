import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { buildEditalTitulo } from "./scraperTitleUtils.mjs";
import { fetchWithScraperAgent } from "./fetchAgent.mjs";

const API_BASE = "https://prosas.com.br/selecao/api/v2/publics/oportunidades";

function toBrDate(iso) {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function incentivadorName(included, relId) {
  if (!relId || !Array.isArray(included)) return undefined;
  const row = included.find((x) => x.type === "incentivador" && String(x.id) === String(relId));
  return row?.attributes?.nome || row?.attributes?.name || undefined;
}

async function fetchPage(page, size) {
  const url = `${API_BASE}?page[page]=${page}&page[size]=${size}&include=area_interesses,incentivador`;
  const res = await fetchWithScraperAgent(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      "User-Agent":
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    },
  });
  if (!res.ok) throw new Error(`Prosas API HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function scrapeProsasCurrentYear() {
  const pageSize = Number(process.env.PROSAS_PAGE_SIZE || "50") || 50;
  const maxPages = Number(process.env.PROSAS_MAX_PAGES || "10") || 10;

  const all = [];
  const seen = new Set();
  let page = 1;
  let last = 1;

  while (page <= maxPages && page <= last) {
    const json = await fetchPage(page, pageSize);
    last = Number(json?.links?.last || last) || last;
    const included = json?.included || [];
    for (const item of json?.data || []) {
      const attrs = item.attributes || {};
      const id = attrs.id || item.id;
      if (!id || seen.has(String(id))) continue;
      seen.add(String(id));
      const titulo = normalizeSpaces(attrs.nome || "");
      if (!titulo || titulo.length < 8) continue;
      const numero = extractNumeroFromText(titulo) || undefined;
      const incentId = item.relationships?.incentivador?.data?.id;
      const orgao = incentivadorName(included, incentId) || "Prosas";
      all.push({
        titulo: buildEditalTitulo({ linkText: titulo, numero, fonte: "prosas" }),
        numero,
        link: `https://prosas.com.br/editais/${id}`,
        dataEncerramento: toBrDate(attrs.data_final_inscricoes || attrs.encerramento_das_inscricoes),
        dataPublicacao: toBrDate(attrs.inicio_inscricoes),
        fonte: "prosas",
        orgao,
        processadoEm: new Date().toISOString(),
      });
    }
    if (!json?.links?.next) break;
    page += 1;
  }

  return filterEditaisCurrentYear(all);
}
