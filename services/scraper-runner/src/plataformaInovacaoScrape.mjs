import * as cheerio from "cheerio";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { describeFetchError } from "./httpFetch.mjs";

const BASE_URL = "https://www.portaldaindustria.com.br";
const PLATAFORMA_BASE = `${BASE_URL}/canais/plataforma-inovacao-para-industria`;

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function absoluteUrl(href) {
  const h = String(href || "").trim();
  if (!h) return h;
  try {
    return new URL(h, PLATAFORMA_BASE).toString();
  } catch {
    if (h.startsWith("/")) return `${BASE_URL}${h}`;
    return h;
  }
}

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  let t;
  try {
    t = setTimeout(() => controller.abort(), timeoutMs);
    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
    return await r.text();
  } catch (e) {
    const base = e instanceof Error ? e : new Error(String(e));
    throw new Error(`${describeFetchError(base)} for ${url}`);
  } finally {
    if (t) clearTimeout(t);
  }
}

async function getCategoryLinks(timeoutMs, maxCategorias) {
  const html = await fetchHtml(PLATAFORMA_BASE, timeoutMs);
  const $ = cheerio.load(html);
  const list = [];
  const seen = new Set();

  $(`a[href*="/canais/plataforma-inovacao-para-industria/categoria/"]`).each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const url = absoluteUrl(href);
    if (seen.has(url)) return;
    seen.add(url);
    const title =
      normalizeSpaces($(el).text()) ||
      url.split("/categoria/")[1]?.replace(/\/$/, "").replace(/-/g, " ") ||
      "Categoria";
    if (title.length < 2) return;
    list.push({ title, url });
  });

  return maxCategorias > 0 ? list.slice(0, maxCategorias) : list;
}

function extractChamadasFromCategoryPage(html, categoryUrl, categoryName) {
  const $ = cheerio.load(html);
  const editais = [];

  const $body = $("main, .content, #content, [class*='content'], body");
  const text = $body.text();

  const inscricoesBlock = /Inscrições:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/gi;
  let m;

  const pdfLinks = [];
  $body.find("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href || href.startsWith("javascript:") || href.startsWith("#")) return;
    const url = absoluteUrl(href);
    const linkText = normalizeSpaces($(a).text());
    if (url.toLowerCase().includes(".pdf")) pdfLinks.push({ url, text: linkText });
  });

  while ((m = inscricoesBlock.exec(text)) !== null) {
    const end = m[2] || m[1] || "";
    const linkForThis = pdfLinks[0]?.url || categoryUrl;
    editais.push({
      titulo: `${categoryName} - Chamada`.slice(0, 400),
      dataEncerramento: end || undefined,
      orgao: categoryName,
      fonte: "plataforma-inovacao-industria",
      link: linkForThis,
      pdfUrls: pdfLinks.map((x) => x.url),
      processadoEm: new Date().toISOString(),
    });
  }

  if (editais.length === 0) {
    editais.push({
      titulo: categoryName,
      link: categoryUrl,
      orgao: categoryName,
      fonte: "plataforma-inovacao-industria",
      pdfUrls: pdfLinks.length ? pdfLinks.map((x) => x.url) : undefined,
      processadoEm: new Date().toISOString(),
    });
  }

  return editais;
}

export async function scrapePlataformaInovacaoCurrentYear() {
  const timeoutMs = Number(process.env.PLATAFORMA_TIMEOUT_MS || "20000") || 20000;
  const maxCategorias = Number(process.env.PLATAFORMA_MAX_CATEGORIAS || "0") || 0;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const categories = await getCategoryLinks(timeoutMs, maxCategorias);
  const all = [];
  const seenTitulo = new Set();

  for (const cat of categories) {
    await delay(300);
    const html = await fetchHtml(cat.url, timeoutMs);
    const editais = extractChamadasFromCategoryPage(html, cat.url, cat.title);
    for (const e of editais) {
      const key = (e.titulo || "").slice(0, 200);
      if (key && !seenTitulo.has(key)) {
        seenTitulo.add(key);
        all.push(e);
      }
    }
  }

  return filterEditaisCurrentYear(all);
}

