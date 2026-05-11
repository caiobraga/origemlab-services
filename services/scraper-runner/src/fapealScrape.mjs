import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://www.fapeal.br";
const LIST_URL = `${BASE}/category/editais/`;

export const scrapeFapealCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapeal",
  orgao: "FAPEAL",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

