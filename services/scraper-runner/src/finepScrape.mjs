import * as cheerio from "cheerio";
import { fetchWithScraperAgent } from "./fetchAgent.mjs";
import { describeFetchError } from "./httpFetch.mjs";
import { fetchRenderedHtml } from "./puppeteerHtml.mjs";
import { absoluteUrl, normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { extractPdfsFromHtml } from "./editalListScrape.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";

const BASE_URL = "https://www.finep.gov.br";
const LEGACY_LIST_URL = `${BASE_URL}/chamadas-publicas/chamadaspublicas?situacao=aberta`;
const OPORTUNIDADES_URL = `${BASE_URL}/oportunidades`;

function normalizeHref(href) {
  const h = String(href || "").trim();
  if (h.startsWith(":80/")) return h.slice(3);
  if (h.startsWith("/:80/")) return h.slice(4);
  return h;
}

function absFinep(href) {
  const h = normalizeHref(href);
  try {
    return new URL(h, BASE_URL).toString();
  } catch {
    if (h.startsWith("/")) return `${BASE_URL}${h}`;
    return h;
  }
}

async function fetchText(url, timeoutMs = 35000) {
  const controller = new AbortController();
  let t;
  try {
    t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetchWithScraperAgent(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8",
        "User-Agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } catch (e) {
    const base = e instanceof Error ? e : new Error(String(e));
    throw new Error(describeFetchError(base));
  } finally {
    if (t) clearTimeout(t);
  }
}

function parseYearFromPtBrDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{4})/);
  if (m) {
    const y = Number(m[1]);
    return Number.isFinite(y) ? y : null;
  }
  const ddmmyyyy = String(s).match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (ddmmyyyy) return Number(ddmmyyyy[3]) || null;
  return null;
}

function isEditalInYear(edital, year) {
  const yPub = parseYearFromPtBrDate(edital.dataPublicacao);
  const yEnc = parseYearFromPtBrDate(edital.dataEncerramento);
  const y = yEnc ?? yPub ?? null;
  if (y === null) return true;
  return y === year;
}

function extractLegacyList(html) {
  const $ = cheerio.load(html);
  const items = [];

  function isDetailLink(u) {
    try {
      const p = new URL(u).pathname.toLowerCase();
      return p.includes("/chamadapublica/");
    } catch {
      return false;
    }
  }

  $("table tbody tr").each((_, el) => {
    const row = $(el);
    const a = row.find("a").first();
    const href = a.attr("href") || "";
    const titulo = normalizeSpaces(a.text());
    if (!href || !titulo) return;
    const link = absFinep(href);
    if (!isDetailLink(link)) return;
    if (/^\+a$/i.test(titulo)) return;
    if (/chamadas\s+p[úu]blicas/i.test(titulo)) return;
    const cols = row.find("td");
    items.push({
      titulo,
      link,
      dataPublicacao: normalizeSpaces($(cols.get(1)).text()) || undefined,
      dataEncerramento: normalizeSpaces($(cols.get(2)).text()) || undefined,
    });
  });

  if (items.length === 0) {
    $("a[href]").each((_, el) => {
      const href = (el.attribs?.href || $(el).attr("href") || "").trim();
      const titulo = normalizeSpaces($(el).text());
      if (!href || !titulo) return;
      const link = absFinep(href);
      if (!isDetailLink(link)) return;
      if (/^\+a$/i.test(titulo) || /chamadas\s+p[úu]blicas/i.test(titulo)) return;
      items.push({ titulo, link });
    });
  }

  const seen = new Set();
  return items.filter((i) => (seen.has(i.link) ? false : (seen.add(i.link), true)));
}

const FINEP_TITLE_BLOCK =
  /^(institucional|oportunidades|explore|busque|financiamento|cr[ée]dito|subven|patroc|contato|acesso)/i;

function isFinepProductLink(link) {
  try {
    const u = new URL(link);
    const p = u.pathname.toLowerCase();
    if (p.includes("/chamadapublica/")) return true;
    if (/\/(financiamento|credito|subvencao|patrocinio)/.test(p)) {
      if (p === "/oportunidades" || p.endsWith("/sobre-a-finep")) return false;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** Portal novo (/oportunidades) — cards de produtos no <main>. */
function extractOportunidadesCards(html) {
  const $ = cheerio.load(html);
  const items = [];
  const seen = new Set();
  const $root = $("body");

  $root.find("a[href]").each((_, a) => {
    const href = $(a).attr("href") || "";
    const link = absFinep(href);
    if (!isFinepProductLink(link)) return;
    if (seen.has(link)) return;

    const titulo =
      normalizeSpaces($(a).find("h2, h3").first().text()) ||
      normalizeSpaces($(a).attr("title")) ||
      normalizeSpaces($(a).text());
    if (!titulo || titulo.length < 6 || titulo.length > 200) return;
    if (FINEP_TITLE_BLOCK.test(titulo)) return;
    if (/^\+a$|ver mais|saiba mais/i.test(titulo)) return;

    seen.add(link);
    items.push({
      titulo: titulo.slice(0, 400),
      link,
      dataPublicacao: undefined,
      dataEncerramento: undefined,
    });
  });

  return items;
}

export async function scrapeFinepCurrentYear() {
  const year = new Date().getFullYear();
  const usePuppeteer = String(process.env.FINEP_USE_PUPPETEER || "1").trim() !== "0";
  const editais = [];
  const seenLinks = new Set();

  const addFromList = async (items, kind) => {
    for (const item of items) {
      if (!isEditalInYear(item, year)) continue;
      if (seenLinks.has(item.link)) continue;
      seenLinks.add(item.link);

      let pdfUrls = [];
      if (kind === "legacy") {
        try {
          const detailHtml = await fetchText(item.link);
          pdfUrls = extractPdfsFromHtml(detailHtml, item.link);
        } catch {
          pdfUrls = [];
        }
      }

      editais.push({
        fonte: "finep",
        titulo: item.titulo,
        link: item.link,
        dataPublicacao: item.dataPublicacao,
        dataEncerramento: item.dataEncerramento,
        processadoEm: new Date().toISOString(),
        pdfUrls: pdfUrls.length ? pdfUrls : undefined,
        numero: extractNumeroFromText(item.titulo) || undefined,
      });
    }
  };

  if (usePuppeteer) {
    try {
      const legacyHtml = await fetchRenderedHtml(LEGACY_LIST_URL, {
        waitForSelector: 'a[href*="chamadapublica"], table tbody tr',
        waitMs: 4000,
      });
      await addFromList(extractLegacyList(legacyHtml), "legacy");
    } catch (e) {
      console.warn(`[scraper.finep] legacy puppeteer: ${e instanceof Error ? e.message : e}`);
    }

    try {
      const opHtml = await fetchRenderedHtml(OPORTUNIDADES_URL, {
        waitMs: 5000,
      });
      await addFromList(extractOportunidadesCards(opHtml), "oportunidade");
    } catch (e) {
      console.warn(`[scraper.finep] oportunidades puppeteer: ${e instanceof Error ? e.message : e}`);
    }
  } else {
    const listHtml = await fetchText(LEGACY_LIST_URL);
    await addFromList(extractLegacyList(listHtml), "legacy");
  }

  return editais.filter((e) => isEditalInYear(e, year));
}
