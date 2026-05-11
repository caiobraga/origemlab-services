import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://www.to.gov.br";
const LIST_URL = "https://www.to.gov.br/fapt/01-editais-abertos/5sy36y0lf49g";

export const scrapeFaptCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapt",
  orgao: "FAPT",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

