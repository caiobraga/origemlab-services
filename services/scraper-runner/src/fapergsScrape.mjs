import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://fapergs.rs.gov.br";
const LIST_URL = `${BASE}/abertos`;

function isFapergsEditalLink(abs) {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("fapergs")) return false;
    return /\/edital-fapergs/i.test(u.pathname) || /\/edital/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const scrapeFapergsCurrentYear = scrapeEditaisFromListPage({
  source: "fapergs",
  orgao: "FAPERGS",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs) => isFapergsEditalLink(abs),
});
