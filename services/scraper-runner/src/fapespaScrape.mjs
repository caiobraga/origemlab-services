import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://www.fapespa.pa.gov.br";
const LIST_URL = `${BASE}/category/editais/`;

export const scrapeFapespaCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapespa",
  orgao: "FAPESPA",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

