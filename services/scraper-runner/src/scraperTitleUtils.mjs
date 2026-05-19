/** Utilitários de título/número para scrapers baseados em links PDF (FUNCAP, FAPAC, etc.). */

export function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

const SUPPLEMENT_START =
  /^(ADENDO|RETIFICA[ÇC][ÃA]O|ERRATA|REPUBLICA[ÇC][ÃA]O|EXTRATO|ANEXO|NOTA\s+EXPLICATIVA|AVISO|ESCLARECIMENTO|RESULTADO|HOMOLOGA[ÇC][ÃA]O|ATA\s+DE)/i;

/** Link que descreve adendo/retificação/etc., não o edital principal. */
export function isSupplementTitle(text) {
  return SUPPLEMENT_START.test(normalizeSpaces(text));
}

/** Número do edital-mãe mencionado no texto (ex.: "ao Edital Nº 15/2024"). */
export function extractParentEditalNumero(text) {
  const t = normalizeSpaces(text);
  const patterns = [
    /edital\s*(?:de\s+chamada\s+p[uú]blica\s*)?n[º°.]?\s*(\d+)\s*\/\s*(\d{4})/i,
    /chamada\s+p[uú]blica\s*n[º°.]?\s*(\d+)\s*\/\s*(\d{4})/i,
    /(?:referente|referente\s+ao|relativo\s+ao|ao|do|da)\s+edital\s*n[º°.]?\s*(\d+)\s*\/\s*(\d{4})/i,
    /(?:do|da|ao|no|na)\s+edital\s+(\d+)\s*\/\s*(\d{4})/i,
    /edital\s*n[º°.]?\s*(\d+)\s*\/\s*(\d{4})/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return "";
}

/**
 * Número do edital para agrupamento/upsert.
 * Adendos órfãos ("ADENDO Nº 02/2024" sem referência ao edital pai) retornam "".
 */
export function extractNumeroFromLinkText(text, { blockContext = "" } = {}) {
  const t = normalizeSpaces(text);
  const block = normalizeSpaces(blockContext);

  const parentFromText = extractParentEditalNumero(t);
  const parentFromBlock = extractParentEditalNumero(block);
  const parent = parentFromText || parentFromBlock;
  if (parent) return parent;

  if (isSupplementTitle(t)) {
    return "";
  }

  const m = t.match(/N[º°]?\s*(\d+)\s*\/\s*(\d{4})/i) || t.match(/Edital\s*(\d+)\s*\/\s*(\d{4})/i);
  if (m) return `${m[1]}/${m[2]}`;

  const m2 = t.match(/(\d{1,4})\/(\d{4})/);
  if (m2) return `${m2[1]}/${m2[2]}`;

  return "";
}

/** Prefere título de edital principal em vez de ADENDO/RETIFICAÇÃO. */
export function pickPreferredTitulo(current, candidate) {
  const cur = normalizeSpaces(current);
  const cand = normalizeSpaces(candidate);
  if (!cur) return cand;
  if (!cand) return cur;

  const score = (s) => {
    if (isSupplementTitle(s)) return 0;
    if (/edital|chamada|sele[cç][ãa]o|programa|fomento|bolsa/i.test(s)) return 2;
    return 1;
  };
  const sc = score(cur);
  const sn = score(cand);
  if (sn > sc) return cand;
  if (sn < sc) return cur;
  return cand.length > cur.length ? cand : cur;
}
