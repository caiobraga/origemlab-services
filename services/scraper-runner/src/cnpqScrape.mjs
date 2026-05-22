import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { buildEditalTitulo } from "./scraperTitleUtils.mjs";
import { withPuppeteerPage, gotoPage } from "./puppeteerHtml.mjs";

const DEFAULT_LIST_URL =
  process.env.CNPQ_CHAMADAS_URL || "https://memoria2.cnpq.br/web/guest/chamadas-publicas";

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

export async function scrapeCnpqCurrentYear() {
  const listUrl = DEFAULT_LIST_URL;
  const maxItems = Number(process.env.CNPQ_MAX_ITEMS || "100") || 100;

  const rows = await withPuppeteerPage(async (page) => {
    await gotoPage(page, listUrl, { waitMs: 5000, timeoutMs: 90000 });

    return page.evaluate((baseUrl, limit) => {
      const editais = [];
      const processedTitles = new Set();

      document.querySelectorAll("li").forEach((listItem) => {
        if (editais.length >= limit) return;
        const titleElement = listItem.querySelector("h1, h2, h3, h4, h5, h6, .title, [class*='title']");
        if (!titleElement) return;
        const headingText = (titleElement.textContent || "").trim().replace(/\s+/g, " ");
        if (!headingText.match(/N[º°]?\s*\d+\/\d+/i) && !/chamada/i.test(headingText)) return;
        if (processedTitles.has(headingText)) return;
        processedTitles.add(headingText);

        const contentText = (listItem.textContent || "").replace(/\s+/g, " ");
        const numeroMatch =
          headingText.match(/N[º°]?\s*(\d+\/\d+)/i) ||
          headingText.match(/Chamada\s+(?:Pública\s+)?(?:CNPq\s*)?N[º°]?\s*(\d+\/\d+)/i) ||
          headingText.match(/(\d+\/\d+)/);
        const numero = numeroMatch ? numeroMatch[1] : undefined;

        const dates = contentText.match(/\d{2}\/\d{2}\/\d{4}/g) || [];
        const uniqueDates = [...new Set(dates)];

        const pdfUrls = [];
        const seenPdf = new Set();
        listItem.querySelectorAll("a[href]").forEach((link) => {
          const href = link.href || link.getAttribute("href") || "";
          if (!href || href.startsWith("javascript:")) return;
          const lower = href.toLowerCase();
          if (
            lower.includes("facebook") ||
            lower.includes("twitter") ||
            lower.includes("whatsapp") ||
            lower.includes("mailto:")
          )
            return;
          let full;
          try {
            full = href.startsWith("http") ? href : new URL(href, baseUrl).href;
          } catch {
            return;
          }
          if (
            !full.includes(".pdf") &&
            !full.includes("/documents/") &&
            !full.includes("/Media/")
          )
            return;
          const norm = full.split("#")[0].toLowerCase();
          if (seenPdf.has(norm)) return;
          seenPdf.add(norm);
          pdfUrls.push(full);
        });

        const validLinks = [];
        listItem.querySelectorAll("a[href]").forEach((link) => {
          const href = link.href || "";
          if (!href || href.includes("javascript:")) return;
          try {
            const full = href.startsWith("http") ? href : new URL(href, baseUrl).href;
            if (
              (full.includes("cnpq.br") || full.includes("memoria2.cnpq.br") || full.includes("chamadas")) &&
              !full.endsWith("#")
            ) {
              validLinks.push({ href: full, text: (link.textContent || "").toLowerCase().trim() });
            }
          } catch {
            // ignore
          }
        });
        const chamadaLink = validLinks.find(
          (l) => l.text === "chamada" || l.text.includes("link permanente") || l.text.includes("chamada"),
        );
        const link = chamadaLink?.href || validLinks[0]?.href || listUrl;

        editais.push({
          titulo: headingText.slice(0, 400),
          numero,
          descricao: contentText.replace(headingText, "").trim().slice(0, 800) || undefined,
          dataPublicacao: uniqueDates[0],
          dataEncerramento: uniqueDates.length > 1 ? uniqueDates[uniqueDates.length - 1] : uniqueDates[0],
          link,
          pdfUrls,
        });
      });

      return editais;
    }, listUrl, maxItems);
  });

  return filterEditaisCurrentYear(rows.map(mapRow));
}
