import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";
import { fetchRenderedHtml } from "./puppeteerHtml.mjs";

const BASE = "https://www.to.gov.br";
const LIST_URL = "https://www.to.gov.br/fapt/01-editais-abertos/5sy36y0lf49g";

function isFaptEditalLink(abs, text = "") {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("to.gov.br")) return false;
    if (!/\/fapt\//i.test(u.pathname)) return false;
    // Skip hub / institutional pages
    if (/01-editais-abertos|\/editais\/\w+$|\/institucional|\/manual|\/carta-de-servicos/i.test(u.pathname)) {
      return false;
    }
    const blob = `${u.pathname} ${text}`;
    return /edital|chamada|programa|bolsista|amplia|rede-de-pesquisa/i.test(blob);
  } catch {
    return false;
  }
}

/**
 * Portal TO gov is JS-rendered; static fetch misses the edital cards.
 */
export const scrapeFaptCurrentYear = scrapeEditaisFromListPage({
  source: "fapt",
  orgao: "FAPT",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs, text) => isFaptEditalLink(abs, text),
  listFetchTimeoutMs: 120000,
  fetchListHtml: async (url) => fetchRenderedHtml(url, { waitMs: 5000, timeoutMs: 120000 }),
});
