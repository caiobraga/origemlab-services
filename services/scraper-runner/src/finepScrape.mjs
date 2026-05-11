import * as cheerio from "cheerio";
import { describeFetchError } from "./httpFetch.mjs";

const BASE_URL = "https://www.finep.gov.br";
const LIST_URL = `${BASE_URL}/chamadas-publicas/chamadaspublicas?situacao=aberta`;

function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeHref(href) {
  const h = String(href || "").trim();
  // Finep sometimes returns weird hrefs like ":80/..." which end up as "/:80/..." when resolved.
  if (h.startsWith(":80/")) return h.slice(3);
  if (h.startsWith("/:80/")) return h.slice(4);
  return h;
}

function absoluteUrl(href) {
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
    const res = await fetch(url, {
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

function extractList(html) {
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
    const link = absoluteUrl(href);
    // Skip header/nav rows (e.g. "Chamadas Públicas", "+A") that are not detail pages.
    if (!isDetailLink(link)) return;
    if (/^\+a$/i.test(titulo)) return;
    if (/chamadas\s+p[úu]blicas/i.test(titulo)) return;

    const cols = row.find("td");
    const dataPublicacao = normalizeSpaces($(cols.get(1)).text());
    const prazoEnvio = normalizeSpaces($(cols.get(2)).text());

    items.push({
      titulo,
      link,
      dataPublicacao: dataPublicacao || undefined,
      dataEncerramento: prazoEnvio || undefined,
    });
  });

  if (items.length === 0) {
    $("a").each((_, el) => {
      const a = $(el);
      const href = (a.attr("href") || "").trim();
      const titulo = normalizeSpaces(a.text());
      if (!href || !titulo) return;
      if (!href.includes("chamadas-publicas")) return;
      const link = absoluteUrl(href);
      if (!isDetailLink(link)) return;
      if (/^\+a$/i.test(titulo)) return;
      if (/chamadas\s+p[úu]blicas/i.test(titulo)) return;
      items.push({ titulo, link });
    });
  }

  const seen = new Set();
  return items.filter((i) => (seen.has(i.link) ? false : (seen.add(i.link), true)));
}

function extractPdfUrlsFromDetail(html) {
  const $ = cheerio.load(html);
  const urls = [];
  const maybePush = (raw) => {
    const href = String(raw || "").trim();
    if (!href) return;
    const abs = absoluteUrl(href);
    const lower = abs.toLowerCase();
    if (lower.includes(".pdf")) urls.push(abs);
  };
  $("a").each((_, el) => {
    maybePush($(el).attr("href"));
  });
  $("iframe,embed,object").each((_, el) => {
    maybePush($(el).attr("src"));
  });
  return [...new Set(urls)];
}

export async function scrapeFinepCurrentYear() {
  const year = new Date().getFullYear();
  const listHtml = await fetchText(LIST_URL);
  const list = extractList(listHtml);

  const editais = [];
  for (const item of list) {
    if (!isEditalInYear(item, year)) continue;

    const detailHtml = await fetchText(item.link);
    const pdfUrls = extractPdfUrlsFromDetail(detailHtml);
    editais.push({
      fonte: "finep",
      titulo: item.titulo,
      link: item.link,
      dataPublicacao: item.dataPublicacao,
      dataEncerramento: item.dataEncerramento,
      processadoEm: new Date().toISOString(),
      pdfUrls,
    });
  }

  return editais.filter((e) => isEditalInYear(e, year));
}

