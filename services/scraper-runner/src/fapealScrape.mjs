import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://www.fapeal.br";
const LIST_URL = `${BASE}/category/editais/`;

function isFapealEditalLink(abs) {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("fapeal.br")) return false;
    if (u.pathname.includes("/category/")) return false;
    return /\/\d{4}\/\d{2}\/edital/i.test(u.pathname) || /\/edital/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const scrapeFapealCurrentYear = scrapeEditaisFromListPage({
  source: "fapeal",
  orgao: "FAPEAL",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs) => isFapealEditalLink(abs),
});
