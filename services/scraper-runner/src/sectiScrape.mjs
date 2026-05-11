import * as cheerio from "cheerio";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";

const BASE = "https://secti.es.gov.br";
const LIST_URL = `${BASE}/editais-abertos`;

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function cleanTitle(s) {
  const t = normalizeSpaces(s);
  return t.replace(/[+\-]\s*$/g, "").trim();
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

function extractEditaisFromHtml(html, pageUrl) {
  const $ = cheerio.load(html);
  const editais = [];

  const anchors = $("a[href^=\"#collapse-\"]").toArray();
  for (const a of anchors) {
    const $a = $(a);
    const href = String($a.attr("href") || "").trim();
    if (!href.startsWith("#collapse-")) continue;
    const titulo = cleanTitle($a.text());
    if (!titulo) continue;

    const $panel = $(href);
    if (!$panel.length) continue;

    const pdfUrls = [];
    $panel.find("a[href]").each((_, linkEl) => {
      const rawHref = String($(linkEl).attr("href") || "").trim();
      if (!rawHref) return;
      if (!rawHref.toLowerCase().includes(".pdf")) return;
      pdfUrls.push(absoluteUrl(rawHref, pageUrl));
    });
    const uniqPdfs = [...new Set(pdfUrls)].filter(Boolean);
    if (!uniqPdfs.length) continue;

    editais.push({
      titulo: titulo.slice(0, 400),
      fonte: "secti",
      orgao: "SECTI-ES",
      link: pageUrl,
      pdfUrls: uniqPdfs,
      processadoEm: new Date().toISOString(),
    });
  }

  return editais;
}

export async function scrapeSectiCurrentYear() {
  const html = await fetchText(LIST_URL, 60000);
  return filterEditaisCurrentYear(extractEditaisFromHtml(html, LIST_URL));
}

