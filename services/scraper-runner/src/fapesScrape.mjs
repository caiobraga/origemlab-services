import * as cheerio from "cheerio";
import { fetchHtml, absoluteUrl, normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { buildEditalTitulo, isSupplementTitle, isWeakLinkTitle } from "./scraperTitleUtils.mjs";
import { resolvePdfFetchUrl } from "./pdfUrlResolve.mjs";

const BASE = "https://fapes.es.gov.br";

/** Hub /Editais/Abertos no longer lists panels — content lives in category pages. */
const LIST_URLS = [
  `${BASE}/edital-aberto-forma%C3%A7%C3%A3o-cient%C3%ADfica`,
  `${BASE}/chamadas-internacionais`,
  `${BASE}/chamamento-publico`,
];

function isFapesPdf(abs) {
  const lower = String(abs || "").toLowerCase();
  if (!lower) return false;
  if (/livro-fapes|ebook|cadastro%20gestor|20%20anos/i.test(lower)) return false;
  // Only real PDFs — anexos .docx/.doc are rejected by upload anyway
  return lower.includes(".pdf");
}

function extractFromPage(html, pageUrl) {
  const $ = cheerio.load(html);
  const byKey = new Map();

  const upsert = (key, row) => {
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, row);
      return;
    }
    cur.pdfUrls = [...new Set([...(cur.pdfUrls || []), ...(row.pdfUrls || [])])];
    if ((row.titulo?.length || 0) > (cur.titulo?.length || 0)) cur.titulo = row.titulo;
    if (!cur.numero && row.numero) cur.numero = row.numero;
  };

  // Collapse headers are the edital titles; nearby PDF anchors belong to that edital.
  $("a[href*='#collapse'], a[data-toggle='collapse'], .panel-title a, [class*='panel-title'] a").each((_, el) => {
    const text = normalizeSpaces($(el).text());
    if (!text || text.length < 10) return;
    if (!/edital|chamada|chamamento/i.test(text)) return;
    if (/^anexo\b/i.test(text)) return;
    const numero = extractNumeroFromText(text);
    const href = String($(el).attr("href") || "");
    const collapseId = href.startsWith("#") ? href.slice(1) : "";
    const pdfUrls = [];

    const collectFrom = ($root) => {
      $root.find("a[href]").each((__, a) => {
        const ah = String($(a).attr("href") || "").trim();
        const abs = absoluteUrl(ah, pageUrl);
        if (!abs || !isFapesPdf(abs)) return;
        if (!/\.pdf/i.test(abs) && !/\/media\/fapes\/editais/i.test(abs)) return;
        pdfUrls.push(resolvePdfFetchUrl(abs));
      });
    };

    if (collapseId) {
      const $panel = $(`#${collapseId}, [id='${collapseId}']`);
      if ($panel.length) collectFrom($panel);
    }
    // Sibling / parent panel body
    const $panelBody = $(el).closest(".panel, .card, .accordion-item, li, div").find(".panel-body, .collapse, .card-body").first();
    if ($panelBody.length) collectFrom($panelBody);

    const key = numero || text.slice(0, 120);
    upsert(key, {
      titulo: text.slice(0, 400),
      numero: numero || undefined,
      link: pageUrl,
      pdfUrls: [...new Set(pdfUrls)],
      fonte: "fapes",
      orgao: "FAPES",
      processadoEm: new Date().toISOString(),
    });
  });

  // Standalone PDF anchors with edital-like link text
  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") || "").trim();
    const abs = absoluteUrl(href, pageUrl);
    if (!abs || !isFapesPdf(abs) || !/\.pdf/i.test(abs)) return;
    const text = normalizeSpaces($(el).text());
    if (!text || text.length < 12) return;
    if (!/edital|chamada|diretrizes|fapes/i.test(text)) return;
    if (isSupplementTitle(text) && !extractNumeroFromText(text)) return;
    const numero = extractNumeroFromText(text);
    const key = numero || text.slice(0, 120);
    upsert(key, {
      titulo: text.slice(0, 400),
      numero: numero || undefined,
      link: pageUrl,
      pdfUrls: [resolvePdfFetchUrl(abs)],
      fonte: "fapes",
      orgao: "FAPES",
      processadoEm: new Date().toISOString(),
    });
  });

  return [...byKey.values()];
}

export async function scrapeFapesCurrentYear() {
  const urls = String(process.env.FAPES_LIST_URLS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const listUrls = urls.length ? urls : LIST_URLS;

  const all = [];
  const seen = new Set();
  for (const url of listUrls) {
    try {
      const html = await fetchHtml(url, 60000);
      for (const row of extractFromPage(html, url)) {
        const key = `${row.numero || ""}|${row.titulo}`.toLowerCase();
        if (seen.has(key)) {
          const prev = all.find((x) => `${x.numero || ""}|${x.titulo}`.toLowerCase() === key);
          if (prev) prev.pdfUrls = [...new Set([...(prev.pdfUrls || []), ...(row.pdfUrls || [])])];
          continue;
        }
        seen.add(key);
        all.push(row);
      }
    } catch (e) {
      console.warn(`[scraper.fapes] fail ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const editais = all
    .map((r) => {
      const numero = r.numero || extractNumeroFromText(r.titulo);
      return {
        ...r,
        titulo: buildEditalTitulo({ linkText: normalizeSpaces(r.titulo), numero, fonte: "fapes" }),
        numero: numero || undefined,
        pdfUrls: r.pdfUrls?.length ? [...new Set(r.pdfUrls)] : undefined,
      };
    })
    .filter((r) => !isWeakLinkTitle(r.titulo) || r.numero);

  return filterEditaisCurrentYear(editais);
}
