import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { buildEditalTitulo } from "./scraperTitleUtils.mjs";
import { withPuppeteerPage, gotoPage } from "./puppeteerHtml.mjs";

const BASE = "https://prosas.com.br";
const EDITAIS_URL = `${BASE}/editais`;

export async function scrapeProsasCurrentYear() {
  const maxPages = Number(process.env.PROSAS_MAX_PAGES || "5") || 5;

  const raw = await withPuppeteerPage(async (page) => {
    await gotoPage(page, EDITAIS_URL, { waitUntil: "networkidle2", waitMs: 4000, timeoutMs: 60000 });
    const all = [];
    const seen = new Set();

    const collect = async () => {
      const chunk = await page.evaluate((baseUrl) => {
        const out = [];
        const add = (titulo, link) => {
          if (!titulo || titulo.length < 5 || !link?.includes("prosas")) return;
          out.push({ titulo: titulo.slice(0, 400), link });
        };
        document.querySelectorAll("a[href]").forEach((a) => {
          const href = a.href || "";
          if (!href.includes("prosas.com.br")) return;
          if (!/\/edital/i.test(href)) return;
          if (href.replace(/\/$/, "") === `${baseUrl}/editais`) return;
          const titulo =
            a.textContent?.trim() ||
            a.closest("[class*='card'], article, li")?.querySelector("h2, h3, h4")?.textContent?.trim() ||
            "";
          add(titulo.replace(/\s+/g, " "), href);
        });
        return out;
      }, BASE);
      for (const r of chunk) {
        const key = r.link;
        if (!seen.has(key)) {
          seen.add(key);
          all.push(r);
        }
      }
    };

    await collect();
    for (let p = 2; p <= maxPages; p++) {
      const clicked = await page.evaluate(() => {
        const el = document.querySelector(
          'a[href*="page="], button[aria-label*="próxim"], [class*="pagination"] a.next, a.next',
        );
        if (!el) return false;
        el.click();
        return true;
      });
      if (!clicked) break;
      await new Promise((r) => setTimeout(r, 1500));
      await collect();
    }
    return all;
  });

  const editais = raw.map((r) => {
    const titulo = normalizeSpaces(r.titulo);
    const numero = extractNumeroFromText(titulo);
    return {
      titulo: buildEditalTitulo({ linkText: titulo, numero, fonte: "prosas" }),
      numero: numero || undefined,
      link: r.link,
      fonte: "prosas",
      orgao: "Prosas",
      processadoEm: new Date().toISOString(),
    };
  });

  return filterEditaisCurrentYear(editais);
}
