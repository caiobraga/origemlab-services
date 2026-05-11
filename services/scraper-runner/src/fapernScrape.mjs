import * as cheerio from "cheerio";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { describeFetchError } from "./httpFetch.mjs";

const BASE = "https://www.fapern.rn.gov.br";
const WP_API_BASE = `${BASE}/wp-json/wp/v2`;
const MATERIA_ENDPOINT = `${WP_API_BASE}/materia`;

function absoluteUrl(href, base = BASE) {
  const h = String(href || "").trim();
  if (!h || h.startsWith("file:") || h.startsWith("#") || h.startsWith("javascript:")) return "";
  try {
    return new URL(h, base).toString();
  } catch {
    if (h.startsWith("/")) return `${base.replace(/\/$/, "")}${h}`;
    return `${base}/${h.replace(/^\//, "")}`;
  }
}

function extractNumero(text) {
  const m = String(text || "").match(/n[º°]?\s*(\d+)\s*\/\s*(\d{4})/i) || String(text || "").match(/(\d{1,4})\/(\d{4})/);
  if (m) return `${m[1]}/${m[2]}`;
  return "";
}

async function fetchText(url, timeoutMs = 90000) {
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
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
    return await r.text();
  } catch (e) {
    const base = e instanceof Error ? e : new Error(String(e));
    throw new Error(describeFetchError(base));
  } finally {
    if (t) clearTimeout(t);
  }
}

async function fetchJson(url, timeoutMs = 90000) {
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
        Accept: "application/json",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} for ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
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

export async function scrapeFapernCurrentYear() {
  const year = new Date().getFullYear();
  const editais = [];

  // WordPress site; we search for posts ("materia") containing "edital".
  // Paginate defensively.
  const perPage = 50;
  for (let page = 1; page <= 10; page++) {
    const url = `${MATERIA_ENDPOINT}?search=edital&per_page=${perPage}&page=${page}&_fields=title,link,date,content`;
    let items;
    try {
      items = await fetchJson(url);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      // If page doesn't exist, stop; otherwise bubble up.
      if (String(err.message || "").includes("HTTP 400") || String(err.message || "").includes("HTTP 404")) break;
      throw err;
    }

    if (!Array.isArray(items) || items.length === 0) break;
    for (const it of items) {
      const date = it?.date ? String(it.date) : "";
      const y = date ? new Date(date).getFullYear() : null;
      if (y && y !== year) continue;

      const titulo = String(it?.title?.rendered || "").replace(/<[^>]*>/g, "").trim() || "Edital FAPERN";
      const link = String(it?.link || "").trim() || BASE;
      const contentHtml = String(it?.content?.rendered || "");
      let pdfUrls = extractPdfUrlsFromHtml(contentHtml);
      if (pdfUrls.length === 0 && link.startsWith("http")) {
        try {
          const pageHtml = await fetchText(link);
          pdfUrls = extractPdfUrlsFromHtml(pageHtml);
        } catch {
          // Best-effort: keep item without pdfs if detail fetch fails.
        }
      }

      editais.push({
        titulo,
        link,
        orgao: "FAPERN",
        fonte: "fapern",
        dataPublicacao: date || undefined,
        processadoEm: new Date().toISOString(),
        pdfUrls,
      });
    }
  }

  // Keep consistent behavior with other scrapers.
  return filterEditaisCurrentYear(editais);
}

