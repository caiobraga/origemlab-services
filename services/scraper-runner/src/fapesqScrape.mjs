import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://fapesq.rpp.br";
const YEAR = new Date().getFullYear();
const LIST_URL = `${BASE}/editais/${YEAR}/editais-${YEAR}`;

export const scrapeFapesqCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapesq",
  orgao: "FAPESQ",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

