import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";
import { fetchRenderedHtml } from "./puppeteerHtml.mjs";

const BASE = "https://fapergs.rs.gov.br";
const LIST_URL = `${BASE}/abertos`;

function isFapergsEditalLink(abs, text = "") {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("fapergs")) return false;
    const path = u.pathname.toLowerCase();
    if (path === "/" || path === "/abertos" || path.includes("/chamadas-e-editais")) return false;
    // CMS pages: /edital-fapergs-..., /chamada-..., sometimes /programa-...
    if (/\/edital/i.test(path) || /\/chamada/i.test(path)) return true;
    if (/edital|chamada/i.test(String(text || "")) && path.length > 8) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * /abertos is a JS CMS shell — static fetch returns almost no edital links.
 */
export const scrapeFapergsCurrentYear = scrapeEditaisFromListPage({
  source: "fapergs",
  orgao: "FAPERGS",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs, text) => isFapergsEditalLink(abs, text),
  fetchListHtml: async (url) => fetchRenderedHtml(url, { waitMs: 4500, timeoutMs: 90000 }),
});
