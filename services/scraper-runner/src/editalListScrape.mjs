import * as cheerio from "cheerio";
import { fetchHtml, absoluteUrl, normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { buildEditalTitulo, isSupplementTitle, isWeakLinkTitle } from "./scraperTitleUtils.mjs";
import { resolvePdfFetchUrl } from "./pdfUrlResolve.mjs";

/** PDFs institucionais que não são edital (rodapé, compliance, etc.). */
export const JUNK_PDF_RE =
  /integridade|compliance|codigo[_-]?conduta|politica[_-]?de|manual-do-usuario|logo|organograma|marca-da-/i;

export function isJunkPdfUrl(url) {
  return JUNK_PDF_RE.test(String(url || ""));
}

export function extractPdfsFromHtml(html, baseUrl, pdfLinkPredicate) {
  const $ = cheerio.load(html);
  const urls = [];
  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") || "").trim();
    if (!href) return;
    const abs = absoluteUrl(href, baseUrl);
    if (!abs) return;
    const isPdf = pdfLinkPredicate ? pdfLinkPredicate(abs, href) : abs.toLowerCase().includes(".pdf");
    if (!isPdf || isJunkPdfUrl(abs)) return;
    urls.push(resolvePdfFetchUrl(abs));
  });
  return [...new Set(urls)];
}

function extractTitleFromDetailHtml(html, fallback) {
  const $ = cheerio.load(html);
  const h1 = normalizeSpaces($("h1").first().text());
  if (h1 && h1.length > 6) return h1.slice(0, 400);
  const title = normalizeSpaces($("title").text());
  if (title && title.length > 6 && !/404|erro/i.test(title)) return title.slice(0, 400);
  return fallback;
}

/**
 * Lista editais: PDFs diretos na listagem + links de detalhe (opcional) com PDFs na página interna.
 */
export function scrapeEditaisFromListPage({
  source,
  orgao,
  listUrl,
  baseUrl,
  isEditalLink = null,
  pdfLinkPredicate = null,
  maxDetailFetches = 120,
  detailDelayMs = 250,
  listFetchTimeoutMs,
}) {
  return async () => {
    const html = await fetchHtml(listUrl, listFetchTimeoutMs);
    const $ = cheerio.load(html);
    const byKey = new Map();

    const upsert = (key, row) => {
      const cur = byKey.get(key);
      if (!cur) {
        byKey.set(key, row);
        return;
      }
      if (row.pdfUrls?.length) {
        cur.pdfUrls = [...new Set([...(cur.pdfUrls || []), ...row.pdfUrls])];
      }
      if (!cur.titulo && row.titulo) cur.titulo = row.titulo;
      if (!cur.link && row.link) cur.link = row.link;
      if (!cur.numero && row.numero) cur.numero = row.numero;
    };

    $("a[href]").each((_, el) => {
      const href = String($(el).attr("href") || "").trim();
      if (!href) return;
      const abs = absoluteUrl(href, baseUrl || listUrl);
      if (!abs) return;
      const text = normalizeSpaces($(el).text());

      const isPdf = pdfLinkPredicate ? pdfLinkPredicate(abs, href) : abs.toLowerCase().includes(".pdf");
      if (isPdf && !isJunkPdfUrl(abs)) {
        const numero = extractNumeroFromText(text);
        const titulo = buildEditalTitulo({ linkText: text, numero, fonte: source });
        const k = numero || titulo;
        const cur = byKey.get(k);
        if (cur) {
          if (!Array.isArray(cur.pdfUrls)) cur.pdfUrls = [];
          const resolved = resolvePdfFetchUrl(abs);
          if (!cur.pdfUrls.includes(resolved)) cur.pdfUrls.push(resolved);
          cur.titulo = buildEditalTitulo({ linkText: cur.titulo, numero: cur.numero || numero, fonte: source });
        } else {
          upsert(k, {
            numero: numero || undefined,
            titulo,
            fonte: source,
            orgao,
            link: listUrl,
            pdfUrls: [resolvePdfFetchUrl(abs)],
            processadoEm: new Date().toISOString(),
          });
        }
        return;
      }

      if (isEditalLink && isEditalLink(abs, text)) {
        const titulo = buildEditalTitulo({ linkText: text, numero: extractNumeroFromText(text), fonte: source });
        const k = abs;
        if (!byKey.has(k)) {
          upsert(k, {
            titulo,
            numero: extractNumeroFromText(titulo) || undefined,
            fonte: source,
            orgao,
            link: abs,
            pdfUrls: [],
            processadoEm: new Date().toISOString(),
            _needsDetail: true,
          });
        }
      }
    });

    const detailRows = [...byKey.values()].filter((r) => r._needsDetail);
    const maxN = Math.max(1, Math.min(maxDetailFetches, detailRows.length));
    for (let i = 0; i < maxN; i++) {
      const row = detailRows[i];
      if (detailDelayMs > 0) await new Promise((r) => setTimeout(r, detailDelayMs));
      try {
        const detailHtml = await fetchHtml(row.link);
        const pdfs = extractPdfsFromHtml(detailHtml, row.link, pdfLinkPredicate);
        row.pdfUrls = [...new Set([...(row.pdfUrls || []), ...pdfs])];
        const detailTitle = extractTitleFromDetailHtml(detailHtml, row.titulo);
        row.titulo = buildEditalTitulo({
          linkText: detailTitle,
          numero: row.numero || extractNumeroFromText(detailTitle),
          fonte: source,
        });
        row.numero = row.numero || extractNumeroFromText(row.titulo);
      } catch {
        // mantém linha sem PDF
      }
      delete row._needsDetail;
    }

    const editais = [...byKey.values()]
      .map((r) => {
        delete r._needsDetail;
        const out = { ...r };
        if (!out.pdfUrls?.length) delete out.pdfUrls;
        out.titulo = buildEditalTitulo({
          linkText: out.titulo,
          numero: out.numero,
          fonte: source,
        });
        return out;
      })
      .filter((r) => !isSupplementTitle(r.titulo) && !isWeakLinkTitle(r.titulo));

    return filterEditaisCurrentYear(editais);
  };
}
