import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://www.fapepi.pi.gov.br";
const LIST_URL = `${BASE}/editais-fapepi/`;

export const scrapeFapepiCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapepi",
  orgao: "FAPEPI",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

