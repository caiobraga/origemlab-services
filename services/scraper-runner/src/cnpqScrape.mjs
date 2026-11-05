import * as cheerio from "cheerio";
import { fetchHtml, absoluteUrl, normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { buildEditalTitulo } from "./scraperTitleUtils.mjs";
import { resolvePdfFetchUrl } from "./pdfUrlResolve.mjs";

/**
 * memoria2.cnpq.br is often blocked (ERR_BLOCKED_BY_CLIENT / Liferay).
 * Prefer the public gov.br listing (static HTML works).
 */
const DEFAULT_LIST_URL =
  process.env.CNPQ_CHAMADAS_URL || "https://www.gov.br/cnpq/pt-br/chamadas/abertas-para-submissao";

function mapRow(r) {
  const numero = r.numero || undefined;
  return {
    titulo: buildEditalTitulo({ linkText: r.titulo, numero, fonte: "cnpq" }),
    numero,
    descricao: r.descricao?.slice(0, 1500),
    dataPublicacao: r.dataPublicacao,
    dataEncerramento: r.dataEncerramento,
    link: r.link,
    fonte: "cnpq",
    orgao: "CNPq",
    pdfUrls: r.pdfUrls?.length ? r.pdfUrls : undefined,
    processadoEm: new Date().toISOString(),
  };
}

function extractNumeroFromTitle(titulo) {
  const t = String(titulo || "");
  const m =
    t.match(/N[º°]?\s*(\d+)\s*\/\s*(\d{4})/i) ||
    t.match(/Chamada[^\d]*(\d+)\s*\/\s*(\d{4})/i) ||
    t.match(/(\d{1,3})\s*\/\s*(20\d{2})/);
  return m ? `${m[1]}/${m[2]}` : extractNumeroFromText(t) || undefined;
}

function isCnpqChamadaLink(abs, text) {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("gov.br") && !u.hostname.includes("cnpq.br")) return false;
    if (/\.pdf($|\?)/i.test(u.pathname)) return false;
    if (!/\/chamadas\//i.test(u.pathname)) return false;
    if (/abertas-para-submissao|analise-em-andamento|todas-as-chamadas\/?$/i.test(u.pathname)) return false;
    if (/busca_|compartilh|facebook|twitter|linkedin|whatsapp|resultado/i.test(abs)) return false;
    const t = String(text || "");
    return /chamada|edital/i.test(t) || /chamada-no-|chamada-publica|chamadas-20\d{2}/i.test(u.pathname);
  } catch {
    return false;
  }
}

async function enrichDetail(link, timeoutMs = 25000) {
  try {
    const html = await fetchHtml(link, timeoutMs);
    const $ = cheerio.load(html);
    const pdfUrls = [];
    $("a[href]").each((_, el) => {
      const href = String($(el).attr("href") || "").trim();
      if (!href) return;
      const abs = absoluteUrl(href, link);
      if (!abs) return;
      const lower = abs.toLowerCase();
      if (!lower.includes(".pdf")) return;
      if (/carta-de-servicos|compartilh|facebook/i.test(lower)) return;
      pdfUrls.push(resolvePdfFetchUrl(abs));
    });
    const text = normalizeSpaces($("main, #content, .documentFirstHeading, body").text());
    const dates = text.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
    const unique = [...new Set(dates)];
    // Descrição só do conteúdo: sem scripts, <noscript> (vaza HTML do GTM), navegação e bloco de compartilhar.
    $("script, style, noscript, iframe, nav, header, footer, .social-links, .viewlet-below-content").remove();
    const root = ["main", "#content", "body"].map((s) => $(s).first()).find((el) => el.length);
    return {
      pdfUrls: [...new Set(pdfUrls)],
      dataPublicacao: unique[0],
      dataEncerramento: unique.length > 1 ? unique[unique.length - 1] : unique[0],
      descricao: normalizeSpaces(root.text()).slice(0, 800) || undefined,
    };
  } catch {
    return { pdfUrls: [], dataPublicacao: undefined, dataEncerramento: undefined };
  }
}

export async function scrapeCnpqCurrentYear() {
  const listUrl = DEFAULT_LIST_URL;
  const maxItems = Number(process.env.CNPQ_MAX_ITEMS || "100") || 100;
  const maxDetail = Number(process.env.CNPQ_MAX_DETAIL || "40") || 40;

  const html = await fetchHtml(listUrl, 60000);
  const $ = cheerio.load(html);
  const byLink = new Map();

  $("a[href]").each((_, el) => {
    const href = String($(el).attr("href") || "").trim();
    const text = normalizeSpaces($(el).text());
    const abs = absoluteUrl(href, listUrl);
    if (!abs || !isCnpqChamadaLink(abs, text)) return;
    if (text.length < 12) return;
    if (byLink.has(abs)) return;
    byLink.set(abs, {
      titulo: text.slice(0, 400),
      numero: extractNumeroFromTitle(text),
      link: abs,
      pdfUrls: [],
    });
  });

  const rows = [...byLink.values()].slice(0, maxItems);
  const detailN = Math.min(maxDetail, rows.length);
  for (let i = 0; i < detailN; i++) {
    const row = rows[i];
    const extra = await enrichDetail(row.link);
    row.pdfUrls = [...new Set([...(row.pdfUrls || []), ...extra.pdfUrls])];
    row.dataPublicacao = extra.dataPublicacao;
    row.dataEncerramento = extra.dataEncerramento;
    if (extra.descricao) row.descricao = extra.descricao;
    if (i + 1 < detailN) await new Promise((r) => setTimeout(r, 200));
  }

  return filterEditaisCurrentYear(rows.map(mapRow));
}
