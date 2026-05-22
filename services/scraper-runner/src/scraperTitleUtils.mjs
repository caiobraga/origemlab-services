/** Utilitários de título/número para scrapers baseados em links PDF (FUNCAP, FAPAC, etc.). */

export function normalizeSpaces(s) {
  return String(s || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

const SUPPLEMENT_START =
  /^(ADENDO|RETIFICA[ÇC][ÃA]O|ERRATA|REPUBLICA[ÇC][ÃA]O|EXTRATO|ANEXO|NOTA\s+EXPLICATIVA|AVISO|ESCLARECIMENTO|RESULTADO|HOMOLOGA[ÇC][ÃA]O|ATA\s+DE)/i;

/** Remove marcadores de lista comuns em links do site (ex.: "- ADENDO Nº 01/2025"). */
export function stripLinkPrefix(text) {
  return normalizeSpaces(text).replace(/^[-–—•]\s+/, "").trim();
}

/** Link que descreve adendo/retificação/etc., não o edital principal. */
export function isSupplementTitle(text) {
  const t = stripLinkPrefix(text);
  return SUPPLEMENT_START.test(t) || /^ADENDO\s+N[º°]/i.test(t);
}

/** Título de link inválido para virar nome do edital (rótulo de UI, data solta, etc.). */
export function isWeakLinkTitle(text) {
  const t = stripLinkPrefix(text);
  if (!t || t.length < 10) return true;
  if (/^[\d]{1,2}\/[\d]{4}\s*[-–—]?\s*$/i.test(t)) return true;
  if (/^(download|saiba mais|ver mais|clique aqui|leia mais)$/i.test(t)) return true;
  if (/^resultado\s+(preliminar|final|complementar)/i.test(t) && !/edital|chamada/i.test(t)) return true;
  if (/^(extrato|homologa[çc][ãa]o)\s+(do|de)\s+resultado/i.test(t)) return true;
  if (/^(organograma|plano de dados|c[óo]digo de conduta)/i.test(t)) return true;
  return false;
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
  const t = stripLinkPrefix(text);
  const block = normalizeSpaces(blockContext);

  const parentFromText = extractParentEditalNumero(t);
  const parentFromBlock = extractParentEditalNumero(block);
  const parent = parentFromText || parentFromBlock;

  if (isSupplementTitle(t)) {
    return parent || "";
  }

  if (parent) return parent;

  const m = t.match(/N[º°]?\s*(\d+)\s*\/\s*(\d{4})/i) || t.match(/Edital\s*(\d+)\s*\/\s*(\d{4})/i);
  if (m) return `${m[1]}/${m[2]}`;

  const m2 = t.match(/(\d{1,4})\/(\d{4})/);
  if (m2) return `${m2[1]}/${m2[2]}`;

  return "";
}

/**
 * Título seguro para gravar no banco a partir do link + número.
 */
export function buildEditalTitulo({ linkText, numero, fonte }) {
  const text = stripLinkPrefix(linkText);
  const num = String(numero || "").trim();
  if (num && (isSupplementTitle(text) || isWeakLinkTitle(text))) {
    return `Edital ${num}`.slice(0, 400);
  }
  if (text && !isSupplementTitle(text) && !isWeakLinkTitle(text) && text.length >= 10) {
    return text.slice(0, 400);
  }
  if (num) return `Edital ${num}`.slice(0, 400);
  return `Edital ${fonte || "origem"}`.slice(0, 400);
}

/** Prefere título de edital principal em vez de ADENDO/RETIFICAÇÃO. */
export function pickPreferredTitulo(current, candidate) {
  const cur = stripLinkPrefix(current);
  const cand = stripLinkPrefix(candidate);
  if (!cur) return cand;
  if (!cand) return cur;

  const score = (s) => {
    if (isSupplementTitle(s) || isWeakLinkTitle(s)) return 0;
    if (/edital|chamada|sele[cç][ãa]o|programa|fomento|bolsa/i.test(s)) return 2;
    return 1;
  };
  const sc = score(cur);
  const sn = score(cand);
  if (sn > sc) return cand;
  if (sn < sc) return cur;
  return cand.length > cur.length ? cand : cur;
}
