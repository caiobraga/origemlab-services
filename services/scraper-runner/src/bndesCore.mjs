/**
 * BNDES — chamadas públicas (núcleo sem dependência de Node).
 *
 * O site do BNDES (IBM WebSphere Portal) não tem uma lista única de chamadas: cada área publica
 * as suas (fundos de investimento, Fundo Rio Doce, BNDES Periferias, …). O scraper lê um conjunto
 * de páginas "hub", segue os links que parecem chamadas/editais e extrai cada página de detalhe
 * (título, descrição, prazos, PDFs).
 *
 * Usado por `bndesScrape.mjs` (scraper-runner, Node) e por `cloudflare/pipeline` (Worker) —
 * por isso recebe `fetchText` injetado e usa `cheerio/slim` (sem undici).
 */
import * as cheerio from "cheerio/slim";

export const BNDES_BASE = "https://www.bndes.gov.br";
const HOME = `${BNDES_BASE}/wps/portal/site/home`;

function wcm(pagePath, uriPath) {
  return `${HOME}/${pagePath}?1dmy&urile=wcm%3apath%3a${encodeURIComponent(uriPath)}`;
}

/** Páginas que listam chamadas (seguimos 1 nível de links a partir delas). */
export const BNDES_HUBS = [
  `${HOME}/mercado-de-capitais/fundos-de-investimentos/chamadas-publicas-para-selecao-de-fundos`,
  wcm(
    "transparencia/fundos-governamentais/fundo-rio-doce",
    "/bndes_institucional/home/transparencia/fundos/fundo-rio-doce/chamadas-editais",
  ),
  wcm("onde-atuamos/social", "/bndes_institucional/home/onde-atuamos/social/bndes-periferias"),
];

const CHAMADA_HINT = /chamada|edital|editais|sele[cç][aã]o|participativo/i;
const DATE_SRC = String.raw`(\d{1,2})[./](\d{1,2})[./](\d{4})`;

function normalizeSpaces(s) {
  return String(s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function absoluteUrl(href, pageUrl) {
  try {
    return new URL(String(href || "").trim(), pageUrl || BNDES_BASE).toString();
  } catch {
    return "";
  }
}

function isBndesHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "") === "bndes.gov.br";
  } catch {
    return false;
  }
}

/** Chave estável da página: o `urile` do WCM (quando houver) ou o path. */
export function bndesPageKey(url) {
  try {
    const u = new URL(url);
    const urile = u.searchParams.get("urile");
    if (urile) return safeDecode(urile).toLowerCase().replace(/\/+$/, "");
    return u.pathname.toLowerCase().replace(/\/+$/, "");
  } catch {
    return String(url || "").toLowerCase();
  }
}

function toIsoDate(d, m, y) {
  const dd = Number(d);
  const mm = Number(m);
  if (!(dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12)) return null;
  return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Texto da página com uma linha por bloco (p, li, h*, …), sem estilos/scripts. */
function blockText($, $root) {
  const $c = $root.clone();
  $c.find("script, style, noscript").remove();
  $c.find("br").replaceWith("\n");
  $c.find("p, li, div, h1, h2, h3, h4, h5, h6, tr").each((_, el) => {
    $(el).append("\n");
  });
  return $c
    .text()
    .split("\n")
    .map((l) => normalizeSpaces(l))
    .filter(Boolean)
    .join("\n");
}

/**
 * Prazos a partir do texto da chamada.
 * - encerramento: maior data de fim de período de recebimento/inscrição (pega prorrogações);
 * - publicação: "lançou, em DD.MM.AAAA" / "Em DD.MM.AAAA" ou início do período.
 */
export function extractBndesDates(text) {
  const t = String(text || "");
  const ends = [];
  const starts = [];
  // Período de recebimento de propostas; "apresentação presencial", "dúvidas" etc. não contam como prazo.
  const KW = String.raw`(?:abert[ao]s?|recebimento|inscri[çc][õo]es|envi(?:o|ad[ao]s?|ar)|encaminhad[ao]s?|submiss[ãa]o|prazo)`;
  const NOT_DEADLINE = /d[úu]vida|esclarecimento|apresenta[çc][ãa]o|resultado/i;
  const UNTIL = String.raw`(?:a|at[ée])\s+(?:(?:as|às)\s+\d{1,2}\s*h(?:\s*\d{2})?(?:min)?\s+(?:do\s+dia\s+)?)?`;

  const range = new RegExp(`${KW}[^\\n]{0,300}?(?:de|a\\s+partir\\s+de)\\s+${DATE_SRC}\\s+${UNTIL}${DATE_SRC}`, "gi");
  for (const m of t.matchAll(range)) {
    if (NOT_DEADLINE.test(m[0])) continue;
    const s = toIsoDate(m[1], m[2], m[3]);
    const e = toIsoDate(m[4], m[5], m[6]);
    if (s) starts.push(s);
    if (e) ends.push(e);
  }
  const until = new RegExp(`${KW}[^\\n]{0,300}?at[ée]\\s+(?:(?:as|às)\\s+\\d{1,2}\\s*h(?:\\s*\\d{2})?(?:min)?\\s+(?:do\\s+dia\\s+)?)?${DATE_SRC}`, "gi");
  for (const m of t.matchAll(until)) {
    if (NOT_DEADLINE.test(m[0])) continue;
    const e = toIsoDate(m[1], m[2], m[3]);
    if (e) ends.push(e);
  }

  let dataPublicacao = null;
  const pub = t.match(new RegExp(`(?:lan[çc]\\w*,?\\s+em|^em)\\s+${DATE_SRC}`, "im"));
  if (pub) dataPublicacao = toIsoDate(pub[1], pub[2], pub[3]);
  if (!dataPublicacao && starts.length) dataPublicacao = [...starts].sort()[0];

  const dataEncerramento = ends.length ? [...ends].sort().at(-1) : null;

  let maxYear = null;
  for (const m of t.matchAll(new RegExp(DATE_SRC, "g"))) {
    const y = Number(m[3]);
    if (maxYear == null || y > maxYear) maxYear = y;
  }
  return { dataPublicacao, dataEncerramento, maxYear };
}

/** Links (no site do BNDES) de uma página hub que parecem chamadas/editais. */
export function extractBndesHubLinks(html, hubUrl) {
  const $ = cheerio.load(html);
  const hubKey = bndesPageKey(hubUrl);
  const out = [];
  const seen = new Set();
  $("a[href]").each((_, a) => {
    const rawHref = String($(a).attr("href") || "").trim();
    if (!rawHref || rawHref.startsWith("#") || /^(mailto|javascript):/i.test(rawHref)) return;
    const url = absoluteUrl(rawHref, hubUrl);
    if (!url || !isBndesHost(url)) return;
    if (/\.(pdf|docx?|xlsx?|zip)(\?|#|$)/i.test(new URL(url).pathname)) return;
    if (/\/wps\/wcm\/connect\//i.test(url)) return;
    const text = normalizeSpaces($(a).text());
    if (!CHAMADA_HINT.test(`${text} ${safeDecode(url)}`)) return;
    const key = bndesPageKey(url);
    if (!key || key === hubKey || seen.has(key)) return;
    seen.add(key);
    out.push({ url, text });
  });
  return out;
}

function pdfScore(text, url) {
  const s = `${text} ${safeDecode(url)}`.toLowerCase();
  if (/edital|chamada|instru[çc]|regulamento|retifica/.test(s)) return 2;
  if (/perguntas|faq|apresenta|folheto|folder|oficina/.test(s)) return 1;
  return 0;
}

/**
 * Extrai a chamada de uma página de detalhe. Retorna `null` se a página não tiver título.
 * `today` (YYYY-MM-DD) é injetável para testes.
 */
export function extractBndesDetail(html, pageUrl, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const $ = cheerio.load(html);
  const $h1 = $("h1.tituloConteudoInterna").first();
  const titulo = normalizeSpaces($h1.text()) || normalizeSpaces($("title").first().text());
  if (!titulo) return null;

  const $root = $h1.length ? $h1.parent() : $("body");
  const text = blockText($, $root);

  let descricao = "";
  $root.find("p").each((_, p) => {
    if (descricao) return;
    const t = normalizeSpaces($(p).text());
    if (t.length >= 80) descricao = t;
  });

  const pdfs = [];
  const seenPdf = new Set();
  $root.find("a[href]").each((_, a) => {
    const url = absoluteUrl($(a).attr("href"), pageUrl);
    if (!url) return;
    let pathname = "";
    try {
      pathname = new URL(url).pathname;
    } catch {
      return;
    }
    if (!/\.pdf$/i.test(pathname)) return;
    const key = pathname.toLowerCase();
    if (seenPdf.has(key)) return;
    seenPdf.add(key);
    pdfs.push({ url, score: pdfScore(normalizeSpaces($(a).text()), url) });
  });
  pdfs.sort((a, b) => b.score - a.score);

  const { dataPublicacao, dataEncerramento, maxYear } = extractBndesDates(text);
  const head = text.slice(0, 600);
  const encerrada = (dataEncerramento && dataEncerramento < today) || /\bresultado\s*(?::|final)/i.test(head);

  return {
    titulo: titulo.slice(0, 400),
    descricao: descricao ? descricao.slice(0, 1000) : undefined,
    fonte: "bndes",
    orgao: "BNDES",
    link: pageUrl,
    dataPublicacao: dataPublicacao || undefined,
    dataEncerramento: dataEncerramento || undefined,
    status: encerrada ? "Encerrada" : "Aberta",
    pdfUrls: pdfs.slice(0, 8).map((p) => p.url),
    processadoEm: new Date().toISOString(),
    _maxYear: maxYear,
  };
}

/** Mantém chamadas do ano corrente em diante (prazo ou publicação; sem datas → descarta). */
export function isBndesChamadaCurrent(e, year = new Date().getFullYear()) {
  const yEnc = e.dataEncerramento ? Number(String(e.dataEncerramento).slice(0, 4)) : null;
  const yPub = e.dataPublicacao ? Number(String(e.dataPublicacao).slice(0, 4)) : null;
  const ref = yEnc ?? yPub ?? e._maxYear ?? null;
  return ref != null && ref >= year;
}

/** Ano mais recente citado no texto do link (ex.: "… - 2018"), para pular páginas antigas sem baixá-las. */
function linkTextYear(text) {
  const ys = [...String(text || "").matchAll(/\b(20\d{2})\b/g)].map((m) => Number(m[1]));
  return ys.length ? Math.max(...ys) : null;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Coleta as chamadas do BNDES.
 * @param {object} opts
 * @param {(url: string) => Promise<string>} opts.fetchText
 * @param {string[]} [opts.hubs]       páginas que listam chamadas
 * @param {string[]} [opts.extraUrls]  páginas de chamada adicionais (ex.: vanity URLs)
 * @param {number}   [opts.maxDetail]  máx. de páginas de detalhe baixadas
 * @param {number}   [opts.concurrency]
 * @param {(msg: string) => void} [opts.log]
 */
export async function scrapeBndesChamadas({
  fetchText,
  hubs = BNDES_HUBS,
  extraUrls = [],
  maxDetail = 60,
  concurrency = 3,
  log = () => {},
} = {}) {
  const year = new Date().getFullYear();
  const candidates = new Map();
  for (const url of extraUrls) {
    if (url) candidates.set(bndesPageKey(url), { url, text: "" });
  }

  for (const hub of hubs) {
    try {
      const html = await fetchText(hub);
      const links = extractBndesHubLinks(html, hub);
      let skippedOld = 0;
      for (const l of links) {
        const y = linkTextYear(l.text);
        if (y != null && y < year - 1) {
          skippedOld += 1;
          continue;
        }
        if (!candidates.has(bndesPageKey(l.url))) candidates.set(bndesPageKey(l.url), l);
      }
      log(`hub ${hub} -> ${links.length} link(s), ${skippedOld} antigo(s) ignorado(s)`);
    } catch (e) {
      log(`hub falhou ${hub}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const list = [...candidates.values()].slice(0, maxDetail);
  const details = await mapLimit(list, concurrency, async (c) => {
    try {
      return extractBndesDetail(await fetchText(c.url), c.url);
    } catch (e) {
      log(`detalhe falhou ${c.url}: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  });

  const out = [];
  const seenTitles = new Set();
  for (const d of details) {
    if (!d || !d.pdfUrls.length) continue;
    if (!isBndesChamadaCurrent(d, year)) continue;
    const tk = d.titulo.toLowerCase();
    if (seenTitles.has(tk)) continue;
    seenTitles.add(tk);
    const { _maxYear, ...edital } = d;
    out.push(edital);
  }
  return out;
}
