import * as cheerio from "cheerio";
import { fetchWithScraperAgent } from "./fetchAgent.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import {
  extractNumeroFromLinkText,
  extractParentEditalNumero,
  isSupplementTitle,
  normalizeSpaces,
  pickPreferredTitulo,
} from "./scraperTitleUtils.mjs";

const BASE = "https://fapac.ac.gov.br";
const LIST_URL = `${BASE}/98-2/`;

function absoluteUrl(href) {
  const h = String(href || "").trim();
  if (!h || h.startsWith("file:")) return "";
  try {
    return new URL(h, BASE).toString();
  } catch {
    if (h.startsWith("/")) return `${BASE}${h}`;
    return `${BASE}/${h}`;
  }
}

function isPdfLink(href) {
  const h = String(href || "").toLowerCase();
  return (h.includes("wp-content/uploads") || h.includes(".pdf")) && h.includes(".pdf");
}

function blockContextForAnchor($, el) {
  const $el = $(el);
  const block = $el.closest("li, tr, article, section, .entry, .post, td, p");
  return normalizeSpaces(block.text()).slice(0, 2500);
}

async function fetchText(url, timeoutMs = 90000) {
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

function extractEditaisFromHtml(html) {
  const $ = cheerio.load(html);
  const pdfLinks = [];

  $('a[href*="wp-content/uploads"], a[href*=".pdf"]').each((_, el) => {
    const href = $(el).attr("href");
    if (!href || !isPdfLink(href)) return;
    const abs = absoluteUrl(href);
    if (!abs) return;
    const text = $(el).text().trim().replace(/\s+/g, " ");
    pdfLinks.push({ href: abs, text, blockContext: blockContextForAnchor($, el) });
  });

  const byNumero = new Map();
  const orphanSupplements = [];

  for (const l of pdfLinks) {
    const text = normalizeSpaces(l.text);
    const numero = extractNumeroFromLinkText(text, { blockContext: l.blockContext });
    const supplement = isSupplementTitle(text);

    if (!numero) {
      if (supplement) orphanSupplements.push(l);
      continue;
    }

    const existing = byNumero.get(numero);
    if (existing) {
      if (!existing.pdfUrls.includes(l.href)) existing.pdfUrls.push(l.href);
      if (!supplement) existing.titulo = pickPreferredTitulo(existing.titulo, text);
    } else {
      const titulo = supplement ? `Edital ${numero}` : text || `Edital ${numero}`;
      byNumero.set(numero, { titulo: pickPreferredTitulo("", titulo), pdfUrls: [l.href] });
    }
  }

  for (const l of orphanSupplements) {
    const parent = extractParentEditalNumero(l.blockContext || "");
    if (!parent) continue;
    const existing = byNumero.get(parent);
    if (existing) {
      if (!existing.pdfUrls.includes(l.href)) existing.pdfUrls.push(l.href);
    } else {
      byNumero.set(parent, { titulo: `Edital ${parent}`, pdfUrls: [l.href] });
    }
  }

  const editais = [];
  for (const [numero, v] of byNumero.entries()) {
    let titulo = String(v.titulo || `Edital ${numero}`).slice(0, 400);
    if (isSupplementTitle(titulo)) titulo = `Edital ${numero}`;
    editais.push({
      numero,
      titulo,
      fonte: "fapac",
      orgao: "FAPAC",
      link: LIST_URL,
      pdfUrls: v.pdfUrls,
      processadoEm: new Date().toISOString(),
    });
  }

  return editais;
}

export async function scrapeFapacCurrentYear() {
  const html = await fetchText(LIST_URL);
  return filterEditaisCurrentYear(extractEditaisFromHtml(html));
}

