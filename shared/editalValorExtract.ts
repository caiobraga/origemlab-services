/**
 * Extração de valores monetários em BRL (compartilhado entre services).
 */

const BRL_AMOUNT_PATTERN = /r\s*\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)/gi;

const WRITTEN_NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  três: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
  treze: 13,
  catorze: 14,
  quatorze: 14,
  quinze: 15,
  dezesseis: 16,
  dezessete: 17,
  dezoito: 18,
  dezenove: 19,
  vinte: 20,
  trinta: 30,
  quarenta: 40,
  cinquenta: 50,
  sessenta: 60,
  setenta: 70,
  oitenta: 80,
  noventa: 90,
  cem: 100,
  cento: 100,
  duzentos: 200,
  trezentos: 300,
  quatrocentos: 400,
  quinhentos: 500,
  seiscentos: 600,
  setecentos: 700,
  oitocentos: 800,
  novecentos: 900,
};

function normalizeWrittenText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function parseBrazilianMoneyToken(raw: string): number | null {
  let s = String(raw || "")
    .trim()
    .replace(/\s/g, "");
  if (!s) return null;

  if (/,\d{1,2}$/.test(s)) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (/\.\d{3}/.test(s)) {
    s = s.replace(/\./g, "");
  }

  const n = Number.parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseWrittenPortugueseMoneyPhrase(text: string): number | null {
  const norm = normalizeWrittenText(text).replace(/\breais?\b/g, " ").replace(/\s+/g, " ").trim();
  if (!norm || !/\b(mil|milhao|milhoes)\b/.test(norm)) return null;

  const tokens = norm.split(/\s+/).filter(Boolean);
  let acc = 0;
  let current = 0;

  for (const tok of tokens) {
    if (tok === "e") continue;
    if (tok === "milhoes" || tok === "milhao") {
      current = (current || 1) * 1_000_000;
      acc += current;
      current = 0;
      continue;
    }
    if (tok === "mil") {
      current = (current || 1) * 1_000;
      acc += current;
      current = 0;
      continue;
    }
    const n = WRITTEN_NUMBER_WORDS[tok];
    if (n != null) current += n;
  }

  acc += current;
  return acc > 0 ? acc : null;
}

function amountsAreNear(a: number, b: number): boolean {
  const base = Math.max(a, b, 1);
  return Math.abs(a - b) / base < 0.01;
}

export function extractValorTextSegments(text: string): string[] {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return [];

  const byConnector = s.split(/\s+e\s+(?=r\s*\$)/i).map((p) => p.trim()).filter(Boolean);
  if (byConnector.length > 1) return byConnector;

  const matches = [...s.matchAll(BRL_AMOUNT_PATTERN)];
  if (matches.length <= 1) return [s];

  const segments: string[] = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index ?? 0;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? s.length) : s.length;
    let chunk = s.slice(start, end).replace(/\s+e\s*$/i, "").trim();
    if (chunk.endsWith(" e")) chunk = chunk.slice(0, -2).trim();
    if (chunk) segments.push(chunk);
  }
  return segments.length > 0 ? segments : [s];
}

export function extractBRLAmountsFromText(text: string): number[] {
  const amounts: number[] = [];
  const s = String(text || "");
  if (!s.trim()) return amounts;

  for (const m of s.matchAll(BRL_AMOUNT_PATTERN)) {
    const n = parseBrazilianMoneyToken(m[1]);
    if (n) amounts.push(n);
  }

  for (const m of s.matchAll(/\(([^)]+)\)/g)) {
    const written = parseWrittenPortugueseMoneyPhrase(m[1]);
    if (written && !amounts.some((a) => amountsAreNear(a, written))) {
      amounts.push(written);
    }
  }

  return amounts;
}

/** Quebra texto longo em linhas `{ valor: [...] }` preservando faixas. */
export function extractValorLinesForStorage(text: string, maxLines = 6, maxLineLen = 160): string[] {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (!s) return [];

  const segments = extractValorTextSegments(s);
  const lines = segments.map((seg) => {
    const paren = /\([^)]+\)/.exec(seg);
    const cleaned = paren ? seg.replace(paren[0], "").replace(/\s+/g, " ").trim() : seg;
    const line = cleaned || seg;
    return line.length > maxLineLen ? `${line.slice(0, maxLineLen - 1)}…` : line;
  });

  return [...new Set(lines)].slice(0, maxLines);
}
