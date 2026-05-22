import * as cheerio from "cheerio";
import { fetchWithScraperAgent } from "./fetchAgent.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { absoluteUrl, normalizeSpaces } from "./simplePdfPageScrape.mjs";
import { extractPdfsFromHtml } from "./editalListScrape.mjs";

const BASE = "https://capta.org.br";
const LIST_URL = `${BASE}/fontes-de-financiamento/oportunidades/`;

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

function parseInscricaoDate(text) {
  const m = String(text || "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  const mes = String(text || "").match(/(\d{1,2})\s+de\s+(junho|julho|maio)[^\d]*(\d{4})/i);
  if (mes) {
    const months = { janeiro: "01", fevereiro: "02", março: "03", abril: "04", maio: "05", junho: "06", julho: "07" };
    const mm = months[mes[2].toLowerCase()] || "06";
    return `${String(mes[1]).padStart(2, "0")}/${mm}/${mes[3]}`;
  }
  return undefined;
}

function extract(html) {
  const $ = cheerio.load(html);
  const editais = [];
  const seen = new Set();

  const push = (row) => {
    const key = (row.titulo || "").slice(0, 120);
    if (!key || seen.has(key)) return;
    seen.add(key);
    editais.push(row);
  };

  $("h2, h3, h4, .elementor-heading-title").each((_, h) => {
    const titulo = normalizeSpaces($(h).text());
    if (!titulo || titulo.length < 8) return;
    if (/oportunidades|fontes de financiamento|capta/i.test(titulo) && titulo.length < 40) return;

    const $section = $(h).closest(".elementor-widget-wrap, .elementor-element, article, section").first();
    const block = $section.length ? $section : $(h).parent();
    const text = normalizeSpaces(block.text());
    const insc = text.match(/Inscri[çc][õo]es\s+at[ée]:?\s*([^<\n]+)/i);
    const dataEncerramento = insc ? parseInscricaoDate(insc[1]) : parseInscricaoDate(text);

    const pdfUrls = extractPdfsFromHtml(block.html() || "", LIST_URL);
    const firstLink = block.find("a[href]").filter((_, a) => {
      const t = normalizeSpaces($(a).text());
      return t.length > 5 && !$(a).attr("href")?.includes(".pdf");
    }).first().attr("href");
    const link = firstLink ? absoluteUrl(firstLink, LIST_URL) : LIST_URL;

    push({
      titulo: titulo.slice(0, 400),
      dataEncerramento,
      fonte: "capta",
      orgao: "Capta",
      link,
      pdfUrls: pdfUrls.length ? pdfUrls : undefined,
      processadoEm: new Date().toISOString(),
    });
  });

  if (editais.length === 0) {
    const parts = html.split(/<h[234][^>]*>/i);
    for (let i = 1; i < parts.length; i++) {
      const chunk = parts[i];
      const titleEnd = chunk.indexOf("</h");
      const titulo = normalizeSpaces(chunk.slice(0, titleEnd).replace(/<[^>]+>/g, ""));
      if (!titulo || titulo.length < 8) continue;
      const body = chunk.slice(titleEnd);
      const insc = body.match(/Inscri[çc][õo]es\s+at[ée]:?\s*([^<]+)/i);
      push({
        titulo: titulo.slice(0, 400),
        dataEncerramento: insc ? parseInscricaoDate(insc[1]) : undefined,
        fonte: "capta",
        orgao: "Capta",
        link: LIST_URL,
        pdfUrls: extractPdfsFromHtml(body, LIST_URL),
        processadoEm: new Date().toISOString(),
      });
    }
  }

  return editais;
}

export async function scrapeCaptaCurrentYear() {
  const html = await fetchText(LIST_URL, 60000);
  return filterEditaisCurrentYear(extract(html));
}
