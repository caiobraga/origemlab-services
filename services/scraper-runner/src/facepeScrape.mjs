import { scrapeEditaisFromListPage } from "./editalListScrape.mjs";

const BASE = "https://www.facepe.br";
const LIST_URL = `${BASE}/editais/todos/?c=aberto`;

export const scrapeFacepeCurrentYear = scrapeEditaisFromListPage({
  source: "facepe",
  orgao: "FACEPE",
  listUrl: LIST_URL,
  baseUrl: BASE,
  pdfLinkPredicate: (abs) => abs.toLowerCase().includes(".pdf") && abs.includes("facepe.br"),
});
