import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://www.fapespa.pa.gov.br";
const LIST_URL = `${BASE}/category/editais/`;

function isFapespaEditalLink(abs) {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("fapespa")) return false;
    if (u.pathname.includes("/category/")) return false;
    return /\/edital/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const scrapeFapespaCurrentYear = scrapeEditaisFromListPage({
  source: "fapespa",
  orgao: "FAPESPA",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs) => isFapespaEditalLink(abs),
});
