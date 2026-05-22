import * as cheerio from "cheerio";
import { fetchWithScraperAgent } from "./fetchAgent.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import {
  buildEditalTitulo,
  extractNumeroFromLinkText,
  extractParentEditalNumero,
  isSupplementTitle,
  normalizeSpaces,
  pickPreferredTitulo,
} from "./scraperTitleUtils.mjs";

const BASE = "https://montenegro.funcap.ce.gov.br/sugba";
const LIST_URL = `${BASE}/editais/`;

function absoluteUrl(href) {
  const h = String(href || "").trim();
  if (!h || h.startsWith("file:")) return "";
  try {
    return new URL(h, LIST_URL).toString();
  } catch {
    if (h.startsWith("/")) return `${BASE}${h}`;
    if (h.startsWith("../")) return new URL(h, LIST_URL).toString();
    return `${BASE}/${h.replace(/^\//, "")}`;
  }
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

function blockContextForAnchor($, el) {
  const $el = $(el);
  const block = $el.closest("li, tr, article, section, .entry, .post, td, .wp-block-group, p");
  return normalizeSpaces(block.text()).slice(0, 2500);
}

function extractEditais(html) {
  const $ = cheerio.load(html);
  const byNumero = new Map();
  /** PDFs de adendo sem número de edital pai no texto — segunda passagem. */
  const orphanSupplements = [];

  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") || "").trim();
    if (!href) return;
    const abs = absoluteUrl(href);
    if (!abs || !abs.toLowerCase().includes(".pdf")) return;

    const text = normalizeSpaces($(el).text());
    if (!text || text.length < 4) return;

    const blockContext = blockContextForAnchor($, el);
    const numero = extractNumeroFromLinkText(text, { blockContext });
    const supplement = isSupplementTitle(text);

    if (!numero) {
      if (supplement) {
        orphanSupplements.push({ abs, text, blockContext });
      }
      return;
    }

    const safeTitulo = buildEditalTitulo({ linkText: text, numero, fonte: "funcap" });
    const existing = byNumero.get(numero);
    if (existing) {
      if (!existing.pdfUrls.includes(abs)) existing.pdfUrls.push(abs);
      if (!supplement) {
        existing.titulo = pickPreferredTitulo(existing.titulo, safeTitulo);
      }
    } else {
      byNumero.set(numero, {
        titulo: pickPreferredTitulo("", safeTitulo),
        pdfUrls: [abs],
      });
    }
  });

  for (const { abs, text, blockContext } of orphanSupplements) {
    const parent = extractParentEditalNumero(blockContext);
    if (!parent) continue;
    const existing = byNumero.get(parent);
    if (existing) {
      if (!existing.pdfUrls.includes(abs)) existing.pdfUrls.push(abs);
    } else {
      byNumero.set(parent, {
        titulo: `Edital ${parent}`,
        pdfUrls: [abs],
      });
    }
  }

  const editais = [];
  for (const [numero, v] of byNumero.entries()) {
    let titulo = buildEditalTitulo({ linkText: v.titulo, numero, fonte: "funcap" });
    editais.push({
      numero,
      titulo,
      fonte: "funcap",
      orgao: "FUNCAP",
      link: LIST_URL,
      pdfUrls: v.pdfUrls,
      processadoEm: new Date().toISOString(),
    });
  }
  return editais;
}

export async function scrapeFuncapCurrentYear() {
  const html = await fetchText(LIST_URL, 90000);
  return filterEditaisCurrentYear(extractEditais(html));
}
