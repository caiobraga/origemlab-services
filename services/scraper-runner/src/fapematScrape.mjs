import * as cheerio from "cheerio";
import { fetchRenderedHtml } from "./puppeteerHtml.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { absoluteUrl, normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { extractPdfsFromHtml } from "./editalListScrape.mjs";
import { buildEditalTitulo } from "./scraperTitleUtils.mjs";

const BASE = "https://www.fapemat.mt.gov.br";
const LIST_URL = `${BASE}/pt/editais_1?categoryId=73983336`;

const DIRECT_PDF_RE = /\.pdf(\?|#|$|\/)/i;
const DOCUMENTS_PDF_RE = /\/documents\/\d+\/\d+\/[^/]+\.pdf\/[a-f0-9-]+/i;

function extractListItems(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();
  $("a[href*='/pt/w/'], a[href*='/w/']").each((_, el) => {
    const href = $(el).attr("href");
    const titulo = normalizeSpaces($(el).text());
    if (!href || titulo.length < 8) return;
    const url = absoluteUrl(href.split("?")[0], BASE);
    if (!url?.includes("fapemat.mt.gov.br") || !url.includes("/w/")) return;
    const key = url.replace(/\/$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ url: key, titulo });
  });
  return items;
}

function extractDetail(html) {
  const $ = cheerio.load(html);
  const titulo =
    normalizeSpaces($("main h3").first().text()) ||
    normalizeSpaces($("main h2").first().text()) ||
    "Edital FAPEMAT";
  const pdfUrls = [];
  $("main a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const abs = absoluteUrl(href, BASE);
    if (!abs?.includes("fapemat.mt.gov.br")) return;
    if (DIRECT_PDF_RE.test(abs) || DOCUMENTS_PDF_RE.test(abs) || abs.includes("/documents/d/")) {
      if (!pdfUrls.includes(abs)) pdfUrls.push(abs);
    }
  });
  const dateMatch = $("main").text().match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  const dataPublicacao = dateMatch ? `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}` : undefined;
  return { titulo, pdfUrls, dataPublicacao };
}

export async function scrapeFapematCurrentYear() {
  const maxItems = Number(process.env.FAPEMAT_MAX_ITEMS || "60") || 60;
  const listHtml = await fetchRenderedHtml(LIST_URL, { waitMs: 4000 });
  let listItems = extractListItems(listHtml);
  if (listItems.length === 0 && process.env.FAPEMAT_EDITAL_URLS) {
    listItems = process.env.FAPEMAT_EDITAL_URLS.split(",")
      .map((u) => u.trim())
      .filter(Boolean)
      .map((url) => ({ url, titulo: "Edital FAPEMAT" }));
  }

  const editais = [];
  for (const { url, titulo: listTitulo } of listItems.slice(0, maxItems)) {
    try {
      const detailHtml = await fetchRenderedHtml(url, { waitMs: 2000 });
      const detail = extractDetail(detailHtml);
      const tituloRaw = detail.titulo.length > 3 ? detail.titulo : listTitulo;
      const numero = extractNumeroFromText(tituloRaw);
      editais.push({
        titulo: buildEditalTitulo({ linkText: tituloRaw, numero, fonte: "fapemat" }),
        numero: numero || undefined,
        link: url,
        dataPublicacao: detail.dataPublicacao,
        fonte: "fapemat",
        orgao: "FAPEMAT",
        pdfUrls: detail.pdfUrls.length ? detail.pdfUrls : undefined,
        processadoEm: new Date().toISOString(),
      });
    } catch {
      // skip
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return filterEditaisCurrentYear(editais);
}
