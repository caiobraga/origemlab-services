import * as cheerio from "cheerio";
import { fetchWithScraperAgent } from "./fetchAgent.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { describeFetchError } from "./httpFetch.mjs";

const BASE_URL = "https://rotadofomento.org";
const EDITAIS_BASE = `${BASE_URL}/editais`;

function absoluteUrl(href) {
  const h = String(href || "").trim();
  if (!h) return h;
  try {
    return new URL(h, EDITAIS_BASE).toString();
  } catch {
    if (h.startsWith("/")) return `${BASE_URL}${h}`;
    return h;
  }
}

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function fetchHtml(url, timeoutMs) {
  const controller = new AbortController();
  let t;
  try {
    t = setTimeout(() => controller.abort(), timeoutMs);
    const r = await fetchWithScraperAgent(url, {
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

function extractEditaisFromPage(html) {
  const $ = cheerio.load(html);
  const editais = [];

  const inscricoesRe = /Inscrições\s+até:\s*(\d{2}\/\d{2}\/\d{4})/i;
  const vigenciaRe = /Vigência:\s*(Encerrado|Aberto|Aberto\.?)/i;

  $("article, .edital-card, [class*='edital'], .post").each((_, block) => {
    const $block = $(block);
    const text = normalizeSpaces($block.text());
    const insMatch = text.match(inscricoesRe);
    const dataEncerramento = insMatch ? insMatch[1] : undefined;
    const vigMatch = text.match(vigenciaRe);
    const status = vigMatch ? vigMatch[1] : undefined;

    const $link = $block
      .find('a[href*="/editais/"]')
      .filter(function () {
        const href = $(this).attr("href") || "";
        return href.includes("/editais/") && !href.endsWith("/editais/");
      })
      .first();
    const href = $link.attr("href");
    const link = href ? absoluteUrl(href) : undefined;
    if (link && /[?&]a=/.test(link)) return;

    let titulo =
      normalizeSpaces($block.find("h2, h3, .entry-title, [class*='title']").first().text()) ||
      normalizeSpaces($link.text());
    if (!titulo && link) {
      const slug = link.split("/editais/")[1]?.replace(/\/$/, "");
      titulo = slug ? slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Edital";
    }
    if (!titulo) return;

    editais.push({
      titulo: titulo.slice(0, 400),
      dataEncerramento,
      status,
      link,
      orgao: "Rota do Fomento",
      fonte: "rotadofomento",
      processadoEm: new Date().toISOString(),
    });
  });

  return editais;
}

function extractPdfUrlsFromHtml(html) {
  const $ = cheerio.load(html);
  const urls = [];
  const maybePush = (raw) => {
    const href = String(raw || "").trim();
    if (!href) return;
    const abs = absoluteUrl(href);
    if (!abs) return;
    const lower = abs.toLowerCase();
    if (lower.includes(".pdf")) urls.push(abs);
  };
  $("a[href]").each((_, el) => maybePush($(el).attr("href")));
  $("iframe,embed,object").each((_, el) => maybePush($(el).attr("src")));
  return [...new Set(urls)];
}

async function enrichWithPdfs(editais, timeoutMs) {
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = [];
  for (const e of editais) {
    const link = e.link;
    if (!link || !String(link).includes("/editais/")) {
      out.push(e);
      continue;
    }
    if (Array.isArray(e.pdfUrls) && e.pdfUrls.length > 0) {
      out.push(e);
      continue;
    }
    await delay(200);
    try {
      const html = await fetchHtml(link, timeoutMs);
      const pdfUrls = extractPdfUrlsFromHtml(html);
      out.push({ ...e, pdfUrls: pdfUrls.length ? pdfUrls : e.pdfUrls });
    } catch {
      out.push(e);
    }
  }
  return out;
}

export async function scrapeRotadofomentoCurrentYear() {
  const timeoutMs = Number(process.env.ROTA_TIMEOUT_MS || "20000") || 20000;
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  const all = [];
  const seen = new Set();

  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const url = page === 1 ? `${EDITAIS_BASE}/` : `${EDITAIS_BASE}/page/${page}/`;
    try {
      await delay(250);
      const html = await fetchHtml(url, timeoutMs);
      const editais = extractEditaisFromPage(html);
      for (const e of editais) {
        const key = (e.link || e.titulo || "").slice(0, 300);
        if (key && !seen.has(key)) {
          seen.add(key);
          all.push(e);
        }
      }
      if (editais.length === 0 && page > 1) hasMore = false;
      else if (page >= 20) hasMore = false;
      else page++;
    } catch {
      hasMore = false;
    }
  }

  const enriched = await enrichWithPdfs(all, timeoutMs);
  return filterEditaisCurrentYear(enriched);
}

