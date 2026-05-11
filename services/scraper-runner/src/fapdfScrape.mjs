import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://www.fap.df.gov.br";
const LIST_URL = `${BASE}/editais-fapdf-20261`;

export const scrapeFapdfCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "fapdf",
  orgao: "FAPDF",
  listUrl: LIST_URL,
  baseUrl: BASE,
  pdfLinkPredicate: (abs, raw) => abs.toLowerCase().includes("/documents/") || abs.toLowerCase().includes(".pdf"),
});

