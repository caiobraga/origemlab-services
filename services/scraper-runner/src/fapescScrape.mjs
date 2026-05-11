import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://fapesc.sc.gov.br";
const LIST_URL = `${BASE}/chamadas-abertas/`;

export const scrapeFapescCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapesc",
  orgao: "FAPESC",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

