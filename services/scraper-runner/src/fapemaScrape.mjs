import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://www.fapema.br";
const LIST_URL = `${BASE}/category/editais/editais-em-aberto/`;

function isFapemaEditalLink(abs) {
  try {
    const u = new URL(abs);
    return u.hostname.includes("fapema.br") && /\/edital-fapema/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const scrapeFapemaCurrentYear = scrapeEditaisFromListPage({
  source: "fapema",
  orgao: "FAPEMA",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs) => isFapemaEditalLink(abs),
});
