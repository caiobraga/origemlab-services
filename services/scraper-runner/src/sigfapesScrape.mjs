import { filterEditaisCurrentYear } from "./yearFilter.mjs";
import { normalizeSpaces, extractNumeroFromText } from "./simplePdfPageScrape.mjs";
import { buildEditalTitulo } from "./scraperTitleUtils.mjs";
import { withPuppeteerPage, gotoPage } from "./puppeteerHtml.mjs";

const LOGIN_URL = "https://www.sigfapes.es.gov.br/";
const EDITAIS_LIST_URL = "https://www.sigfapes.es.gov.br/index.php?id=7&acao=1";

async function loginSigfapes(page, username, password) {
  await gotoPage(page, LOGIN_URL, { waitMs: 3000, timeoutMs: 60000 });

  const loginSelectors = [
    'input[name="login"]',
    'input[name="usuario"]',
    'input[name="cpf"]',
    'input[type="text"]:not([type="password"])',
  ];
  let filled = false;
  for (const sel of loginSelectors) {
    const el = await page.$(sel);
    if (el) {
      await el.click({ clickCount: 3 }).catch(() => {});
      await el.type(username, { delay: 40 });
      filled = true;
      break;
    }
  }
  if (!filled) throw new Error("sigfapes_login_field_not_found");

  const passEl = await page.$('input[type="password"]');
  if (!passEl) throw new Error("sigfapes_password_field_not_found");
  await passEl.type(password, { delay: 40 });

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button, input[type='submit'], a")].find((el) =>
      /entrar|login|acessar/i.test(el.textContent || el.value || ""),
    );
    if (btn) (btn).click();
  });
  await new Promise((r) => setTimeout(r, 4000));
}

export async function scrapeSigfapesCurrentYear() {
  const username = String(process.env.SIGFAPES_USERNAME || process.env.SIGFAPES_LOGIN || "").trim();
  const password = String(process.env.SIGFAPES_PASSWORD || "").trim();

  if (!username || !password) {
    console.warn(
      "[scraper.sigfapes] SIGFAPES_USERNAME e SIGFAPES_PASSWORD não configurados — fonte ignorada.",
    );
    return [];
  }

  const rows = await withPuppeteerPage(async (page) => {
    await loginSigfapes(page, username, password);
    await gotoPage(page, EDITAIS_LIST_URL, { waitMs: 3500, timeoutMs: 60000 });

    return page.evaluate((listUrl) => {
      const out = [];
      const seen = new Set();
      document.querySelectorAll("a").forEach((a) => {
        const text = (a.textContent || "").trim().replace(/\s+/g, " ");
        if (!/edital|chamada/i.test(text) || text.length < 12) return;
        const key = text.slice(0, 120);
        if (seen.has(key)) return;
        seen.add(key);

        const numeroMatch = text.match(/(?:n[º°]?\s*)?(\d+\s*\/\s*\d{4}|\d+\/\d+)/i);
        const numero = numeroMatch ? numeroMatch[1].replace(/\s+/g, "") : undefined;
        const pdfUrls = [];
        const row = a.closest("tr, li, div");
        if (row) {
          row.querySelectorAll('a[href*=".pdf"], a[href*="download"]').forEach((lnk) => {
            const href = lnk.href || "";
            if (href && !pdfUrls.includes(href)) pdfUrls.push(href);
          });
        }

        out.push({
          titulo: text.slice(0, 400),
          numero,
          link: a.href || listUrl,
          pdfUrls,
        });
      });
      return out;
    }, EDITAIS_LIST_URL);
  });

  const editais = rows
    .filter((r) => r.titulo && !/^anexo\b/i.test(r.titulo))
    .map((r) => {
      const numero = r.numero || extractNumeroFromText(r.titulo);
      return {
        titulo: buildEditalTitulo({ linkText: normalizeSpaces(r.titulo), numero, fonte: "sigfapes" }),
        numero: numero || undefined,
        link: r.link,
        fonte: "sigfapes",
        orgao: "SIGFAPES",
        pdfUrls: r.pdfUrls?.length ? r.pdfUrls : undefined,
        processadoEm: new Date().toISOString(),
      };
    });

  return filterEditaisCurrentYear(editais);
}
