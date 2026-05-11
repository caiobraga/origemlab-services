import * as cheerio from "cheerio";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";

const BASE = "https://montenegro.funcap.ce.gov.br/sugba";
const LIST_URL = `${BASE}/editais/`;

function absoluteUrl(href) {
  const h = String(href || "").trim();
  if (!h || h.startsWith("file:")) return "";
  try {
    return new URL(h, LIST_URL).toString();
  } catch {
    if (h.startsWith("/")) return `${BASE}${h}`;
    if (h.startsWith("../")) return new URL(h, LIST_URL).toString();
    return `${BASE}/${h.replace(/^\//, "")}`;
  }
}

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function extractNumero(titulo) {
  const t = String(titulo || "");
  const m = t.match(/N[º°]?\s*(\d+)\s*\/\s*(\d{4})/i) || t.match(/Edital\s*(\d+)\s*\/\s*(\d{4})/i);
  if (m) return `${m[1]}/${m[2]}`;
  const m2 = t.match(/(\d{1,4})\/(\d{4})/);
  if (m2) return `${m2[1]}/${m2[2]}`;
  return "";
}

async function fetchText(url, timeoutMs = 60000) {
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

function extractEditais(html) {
  const $ = cheerio.load(html);
  const byNumero = new Map();

  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") || "").trim();
    if (!href) return;
    const abs = absoluteUrl(href);
    if (!abs || !abs.toLowerCase().includes(".pdf")) return;
    const text = normalizeSpaces($(el).text());
    const numero = extractNumero(text);
    if (!numero) return;

    const existing = byNumero.get(numero);
    if (existing) {
      if (!existing.pdfUrls.includes(abs)) existing.pdfUrls.push(abs);
    } else {
      byNumero.set(numero, { titulo: text || `Edital ${numero}`, pdfUrls: [abs] });
    }
  });

  const editais = [];
  for (const [numero, v] of byNumero.entries()) {
    editais.push({
      numero,
      titulo: String(v.titulo || `Edital ${numero}`).slice(0, 400),
      fonte: "funcap",
      orgao: "FUNCAP",
      link: LIST_URL,
      pdfUrls: v.pdfUrls,
      processadoEm: new Date().toISOString(),
    });
  }
  return editais;
}

export async function scrapeFuncapCurrentYear() {
  const html = await fetchText(LIST_URL, 90000);
  return filterEditaisCurrentYear(extractEditais(html));
}

