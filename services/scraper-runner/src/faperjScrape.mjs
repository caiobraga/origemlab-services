import { scrapePdfAnchorsFromSinglePage } from "./simplePdfPageScrape.mjs";

const BASE = "https://www.faperj.br";
const LIST_URL = `${BASE}/?id=28.5.7`;

export const scrapeFaperjCurrentYear = scrapePdfAnchorsFromSinglePage({
  source: "faperj",
  orgao: "FAPERJ",
  listUrl: LIST_URL,
  baseUrl: BASE,
  pdfLinkPredicate: (abs, raw) => abs.toLowerCase().includes(".pdf") || abs.toLowerCase().includes("rp/downloads"),
});

