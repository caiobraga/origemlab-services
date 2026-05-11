import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://fapitec.se.gov.br";
const LIST_URL = `${BASE}/editais-abertos/`;

export const scrapeFapitecCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapitec",
  orgao: "FAPITEC-SE",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

