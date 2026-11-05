import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://www.fapespa.pa.gov.br";
/** /category/editais/ is empty; real posts live under Chamadas. */
const LIST_URL = `${BASE}/category/chamadas/`;

function isFapespaEditalLink(abs, text = "") {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("fapespa")) return false;
    if (u.pathname.includes("/category/")) return false;
    if (u.pathname.includes("/author/")) return false;
    if (/\/\d{4}\/\d{2}\/?$/.test(u.pathname)) return false; // archive months
    // WordPress permalinks: /2026/09/14/chamada-n-o-023-2026-...
    if (/\/20\d{2}\/\d{2}\/\d{2}\//.test(u.pathname)) {
      return /edital|chamada|chamamento|programa/i.test(u.pathname + " " + text);
    }
    if (/\/edital|\/chamada/i.test(u.pathname)) return true;
    return /edital|chamada pública|chamada n/i.test(String(text || ""));
  } catch {
    return false;
  }
}

export const scrapeFapespaCurrentYear = scrapeEditaisFromListPage({
  source: "fapespa",
  orgao: "FAPESPA",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs, text) => isFapespaEditalLink(abs, text),
  pdfLinkPredicate: (abs) => {
    const lower = String(abs || "").toLowerCase();
    return lower.includes(".pdf");
  },
});
