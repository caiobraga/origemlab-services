import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://fapergs.rs.gov.br";
const LIST_URL = `${BASE}/abertos`;

export const scrapeFapergsCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapergs",
  orgao: "FAPERGS",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

