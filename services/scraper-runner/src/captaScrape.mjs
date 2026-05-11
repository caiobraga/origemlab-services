import * as cheerio from "cheerio";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";

const BASE = "https://capta.org.br";
const LIST_URL = `${BASE}/fontes-de-financiamento/oportunidades/`;

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function absoluteUrl(href, pageUrl) {
  const h = String(href || "").trim();
  if (!h) return h;
  try {
    return new URL(h, pageUrl || BASE).toString();
  } catch {
    if (h.startsWith("/")) return `${BASE}${h}`;
    return h;
  }
}

async function fetchText(url, timeoutMs = 35000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
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

function extract(html) {
  const $ = cheerio.load(html);
  const editais = [];

  // Heuristic: Capta uses cards with title + "Inscrições até" and links to edital/regulamento.
  $("[class*='oportunidade'], article, .elementor-widget-container, .elementor-post").each((_, el) => {
    const $el = $(el);
    const text = normalizeSpaces($el.text());
    if (!text || text.length < 40) return;

    const title =
      normalizeSpaces($el.find("h1,h2,h3,h4,.elementor-heading-title,.entry-title").first().text()) ||
      normalizeSpaces($el.find("a").first().text());
    if (!title || title.length < 6) return;

    const m = text.match(/Inscri[çc][õo]es\s+at[ée]:?\s*(\d{2}\/\d{2}\/\d{4})/i);
    const dataEncerramento = m ? m[1] : undefined;

    const pdfUrls = [];
    $el.find("a[href]").each((_, a) => {
      const href = String($(a).attr("href") || "").trim();
      if (!href) return;
      const abs = absoluteUrl(href, LIST_URL);
      if (abs.toLowerCase().includes(".pdf")) pdfUrls.push(abs);
    });

    const firstLink = $el.find("a[href]").first().attr("href");
    const link = firstLink ? absoluteUrl(firstLink, LIST_URL) : LIST_URL;

    editais.push({
      titulo: title.slice(0, 400),
      descricao: undefined,
      dataEncerramento,
      fonte: "capta",
      orgao: "Capta",
      link,
      pdfUrls: pdfUrls.length ? [...new Set(pdfUrls)] : undefined,
      processadoEm: new Date().toISOString(),
    });
  });

  return editais;
}

export async function scrapeCaptaCurrentYear() {
  const html = await fetchText(LIST_URL, 60000);
  return filterEditaisCurrentYear(extract(html));
}

