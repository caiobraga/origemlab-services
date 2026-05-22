import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://www.to.gov.br";
const LIST_URL = "https://www.to.gov.br/fapt/01-editais-abertos/5sy36y0lf49g";

function isFaptEditalLink(abs) {
  try {
    const u = new URL(abs);
    return u.hostname.includes("to.gov.br") && /fapt|edital/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const scrapeFaptCurrentYear = scrapeEditaisFromListPage({
  source: "fapt",
  orgao: "FAPT",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs) => isFaptEditalLink(abs),
  listFetchTimeoutMs: 120000,
});
