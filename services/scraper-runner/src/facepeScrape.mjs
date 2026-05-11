import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://www.facepe.br";
const LIST_URL = `${BASE}/editais/todos/?c=aberto`;

export const scrapeFacepeCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "facepe",
  orgao: "FACEPE",
  listUrl: LIST_URL,
  baseUrl: BASE,
});

