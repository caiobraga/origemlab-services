import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://www.fapepi.pi.gov.br";
const LIST_URL = `${BASE}/editais-fapepi/`;

function isFapepiEditalLink(abs) {
  try {
    const u = new URL(abs);
    if (!u.hostname.includes("fapepi")) return false;
    if (u.pathname === "/editais-fapepi/" || u.pathname === "/editais-fapepi") return false;
    return /\/edital/i.test(u.pathname);
  } catch {
    return false;
  }
}

export const scrapeFapepiCurrentYear = scrapeEditaisFromListPage({
  source: "fapepi",
  orgao: "FAPEPI",
  listUrl: LIST_URL,
  baseUrl: BASE,
  isEditalLink: (abs, text) => isFapepiEditalLink(abs) && text.length > 8,
});
