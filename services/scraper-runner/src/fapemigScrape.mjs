import { fetchWithScraperAgent } from "./fetchAgent.mjs";
import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { buildEditalTitulo } from "./scraperTitleUtils.mjs";
import { withPuppeteerPage, gotoPage } from "./puppeteerHtml.mjs";

const BASE = "https://fapemig.br";
const LIST_URL = `${BASE}/oportunidades/chamadas-e-editais?status=aberta`;
const PDF_URL_RE = /https:\/\/api\.site\.fapemig\.br\/wp-content\/uploads\/[^"\\s]+\.pdf/gi;

async function getPdfUrlsFromDetail(detailPath) {
  let pathname = detailPath;
  if (detailPath.startsWith("http")) {
    try {
      pathname = new URL(detailPath).pathname;
    } catch {
      pathname = detailPath.replace(/^https?:\/\/[^/]+/, "");
    }
  }
  const payloadUrl = `${BASE}${pathname.replace(/\/?$/, "")}/_payload.json`;
  try {
    const res = await fetchWithScraperAgent(payloadUrl, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return [];
    const text = await res.text();
    return [...new Set(text.match(PDF_URL_RE) || [])];
  } catch {
    return [];
  }
}

function numeroFromHref(href) {
  const slug = href.split("/chamada-")[1]?.split("/")[0] || href;
  const m =
    slug.match(/chamada-fapemig-(\d+)-(\d+)/i) ||
    slug.match(/(\d{2,3})-(\d{4})/) ||
    href.match(/(\d+)\/(\d{4})/);
  return m ? `${m[1]}/${m[2]}` : "";
}

export async function scrapeFapemigCurrentYear() {
  const maxItems = Number(process.env.FAPEMIG_MAX_ITEMS || "80") || 80;
  const links = await withPuppeteerPage(async (page) => {
    await gotoPage(page, LIST_URL, { waitMs: 3000, timeoutMs: 60000 });
    const items = [];
    const seen = new Set();
    for (let load = 0; load < 15; load++) {
      const chunk = await page.evaluate((base) => {
        const out = [];
        document.querySelectorAll('a[href*="/chamada-"]').forEach((a) => {
          const href = a.href || a.getAttribute("href") || "";
          if (!href.includes("/chamada-")) return;
          const full = href.startsWith("http") ? href : new URL(href, base).toString();
          let titulo =
            a.closest("article, [class*='card']")?.querySelector("h2, h3, h4")?.textContent?.trim() ||
            a.textContent?.trim() ||
            "";
          titulo = titulo.replace(/\s+/g, " ").trim();
          if (/^saiba mais$/i.test(titulo)) titulo = full.split("/chamada-")[1]?.replace(/-/g, " ") || titulo;
          out.push({ href: full.replace(/#.*$/, ""), titulo });
        });
        return out;
      }, BASE);
      for (const it of chunk) {
        if (!seen.has(it.href)) {
          seen.add(it.href);
          items.push(it);
        }
      }
      if (items.length >= maxItems) break;
      const clicked = await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button, a")].find((el) =>
          /carregar\s*mais|load\s*more/i.test(el.textContent || ""),
        );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      });
      if (!clicked) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    return items.slice(0, maxItems);
  });

  const editais = [];
  for (const { href, titulo: rawTitulo } of links) {
    const titulo = normalizeSpaces(rawTitulo).slice(0, 400) || `Chamada FAPEMIG`;
    const numero = numeroFromHref(href) || extractNumeroFromText(titulo);
    const pdfUrls = await getPdfUrlsFromDetail(href);
    editais.push({
      titulo: buildEditalTitulo({ linkText: titulo, numero, fonte: "fapemig" }),
      numero: numero || undefined,
      link: href,
      fonte: "fapemig",
      orgao: "FAPEMIG",
      pdfUrls: pdfUrls.length ? pdfUrls : undefined,
      processadoEm: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 150));
  }
  return filterEditaisCurrentYear(editais);
}
