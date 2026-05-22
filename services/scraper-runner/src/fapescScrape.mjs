import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://fapesc.sc.gov.br";
const LIST_URL = `${BASE}/chamadas-abertas/`;

function isFapescEditalLink(abs, text) {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("fapesc.sc.gov.br")) return false;
    return /\/edital-de-chamada/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const scrapeFapescCurrentYear = scrapeEditaisFromListPage({
  source: "fapesc",
  orgao: "FAPESC",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: isFapescEditalLink,
});
