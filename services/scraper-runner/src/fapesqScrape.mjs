import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://fapesq.rpp.br";
const YEAR = new Date().getFullYear();
const LIST_URL = `${BASE}/editais/${YEAR}/editais-${YEAR}`;

function isFapesqEditalLink(abs) {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("fapesq.rpp.br")) return false;
    return /\/editais\/\d{4}\/edital-no-/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const scrapeFapesqCurrentYear = scrapeEditaisFromListPage({
  source: "fapesq",
  orgao: "FAPESQ",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs, _text) => isFapesqEditalLink(abs),
});
