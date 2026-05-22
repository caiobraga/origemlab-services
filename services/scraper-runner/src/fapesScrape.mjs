import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { buildEditalTitulo } from "./scraperTitleUtils.mjs";
import { withPuppeteerPage, gotoPage } from "./puppeteerHtml.mjs";

const EDITAIS_URL = "https://fapes.es.gov.br/Editais/Abertos";

export async function scrapeFapesCurrentYear() {
  const maxPanels = Number(process.env.FAPES_MAX_PANELS || "40") || 40;

  const rows = await withPuppeteerPage(async (page) => {
    await gotoPage(page, EDITAIS_URL, { waitMs: 3500, timeoutMs: 60000 });
    const panelCount = await page.$$eval(
      '.panel-title, [class*="panel-title"], [data-toggle="collapse"], a[href*="#collapse"]',
      (els) => els.length,
    );
    const out = [];
    for (let i = 0; i < Math.min(panelCount, maxPanels); i++) {
      const titles = await page.$$(
        '.panel-title, [class*="panel-title"], [data-toggle="collapse"], a[href*="#collapse"]',
      );
      if (!titles[i]) break;
      await titles[i].evaluate((el) => el.scrollIntoView({ block: "center" }));
      await new Promise((r) => setTimeout(r, 200));
      await titles[i].click({ delay: 80 }).catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));

      const row = await page.evaluate(
        (baseUrl, panelIndex) => {
          const expanded = document.querySelectorAll(
            '.collapse.show, .collapse.in, [class*="collapse"][class*="show"], [class*="collapse"][class*="in"]',
          );
          const panel = expanded[panelIndex] || expanded[expanded.length - 1];
          if (!panel) return null;

          let panelTitle = "";
          let container = panel.parentElement;
          for (let d = 0; d < 8 && container; d++) {
            const t = container.querySelector(".panel-title, h3, h4, h5");
            if (t?.textContent?.trim()) {
              panelTitle = t.textContent.trim().replace(/\s+/g, " ");
              break;
            }
            container = container.parentElement;
          }
          if (!panelTitle || panelTitle.length < 5) return null;
          if (/^anexo\b/i.test(panelTitle)) return null;

          const numeroMatch = panelTitle.match(/N[º°]?\s*(\d+\/\d+)/i) || panelTitle.match(/(\d+\/\d+)/);
          const pdfUrls = [];
          const seen = new Set();
          panel.querySelectorAll("a[href]").forEach((a) => {
            const href = a.href || a.getAttribute("href") || "";
            if (!href || seen.has(href)) return;
            if (!/\.pdf/i.test(href) && !href.includes("/Media/") && !href.includes("/Editais/")) return;
            try {
              const full = href.startsWith("http") ? href : new URL(href, baseUrl).href;
              seen.add(href);
              pdfUrls.push(full);
            } catch {
              // ignore
            }
          });
          if (pdfUrls.length === 0) return null;

          const dates = (panel.textContent || "").match(/\d{2}\/\d{2}\/\d{4}/g) || [];
          return {
            titulo: panelTitle,
            numero: numeroMatch ? numeroMatch[1] : undefined,
            pdfUrls,
            dataEncerramento: dates.length ? dates[dates.length - 1] : undefined,
            link: pdfUrls[0],
          };
        },
        "https://fapes.es.gov.br",
        i,
      );
      if (row) out.push(row);
    }
    return out;
  });

  const editais = rows.map((r) => {
    const numero = r.numero || extractNumeroFromText(r.titulo);
    return {
      titulo: buildEditalTitulo({ linkText: normalizeSpaces(r.titulo), numero, fonte: "fapes" }),
      numero: numero || undefined,
      link: r.link,
      dataEncerramento: r.dataEncerramento,
      fonte: "fapes",
      orgao: "FAPES",
      pdfUrls: r.pdfUrls,
      processadoEm: new Date().toISOString(),
    };
  });

  return filterEditaisCurrentYear(editais);
}
