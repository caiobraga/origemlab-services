import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://www.fapema.br";
const LIST_URL = `${BASE}/category/editais/editais-em-aberto/`;

export const scrapeFapemaCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapema",
  orgao: "FAPEMA",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

