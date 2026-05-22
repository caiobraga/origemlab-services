import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://fapitec.se.gov.br";
const LIST_URL = `${BASE}/editais-abertos/`;

function isFapitecEditalLink(abs) {
  try {
    const u = new URL(abs);
    return u.hostname.includes("fapitec") && /\/editais-abertos\/edital/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const scrapeFapitecCurrentYear = scrapeEditaisFromListPage({
  source: "fapitec",
  orgao: "FAPITEC-SE",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs) => isFapitecEditalLink(abs),
});
