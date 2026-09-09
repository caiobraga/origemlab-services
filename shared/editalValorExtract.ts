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

function safeParseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Extrai linhas legíveis de `valor_projeto` (string JSON `{valor:[...]}`, objeto ou texto). */
export function flattenValorProjetoLines(value: unknown): string[] {
  if (value == null) return [];

  const fromObject = (obj: Record<string, unknown>): string[] => {
    const items: string[] = [];
    const v = obj.valor;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string") {
          const t = x.replace(/\s+/g, " ").trim();
          if (t) items.push(t);
        } else if (x && typeof x === "object" && (x as { valor?: unknown }).valor != null) {
          const t = String((x as { valor: unknown }).valor).replace(/\s+/g, " ").trim();
          if (t) items.push(t);
        }
      }
    } else if (typeof v === "string") {
      const t = v.replace(/\s+/g, " ").trim();
      if (t) items.push(t);
    }
    return items;
  };

  if (typeof value === "object" && value !== null) {
    return fromObject(value as Record<string, unknown>);
  }

  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return [];

  if (text.startsWith("{")) {
    const parsed = safeParseJsonObject(text);
    if (parsed) return fromObject(parsed);
  }

  return [text];
}

/** Normaliza referência tipo edital/chamada (`046/2026`, `00001946/2026`) para comparação. */
export function normalizeEditalNumeroRef(raw: string): string | null {
  const m = /^(\d{1,10})\s*\/\s*(\d{4})$/.exec(String(raw || "").replace(/\s/g, ""));
  if (!m) return null;
  return `${Number.parseInt(m[1], 10)}/${m[2]}`;
}

const EDITAL_NUMERO_LINE = /^(\d{1,10}|0+\d{1,10})\s*\/\s*\d{4}$/;
const PURE_DATE_LINE =
  /^\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}$|^\d{4}-\d{2}-\d{2}$|^\d{1,2}\s+de\s+\w+\s+de\s+\d{4}$/i;

/** Linha que parece número de edital/chamada, não valor financeiro. */
export function valorLineLooksLikeEditalNumero(line: string): boolean {
  const t = String(line || "").replace(/\s+/g, " ").trim();
  if (!t) return false;
  if (/r\s*\$/i.test(t)) return false;
  if (EDITAL_NUMERO_LINE.test(t)) return true;
  const compact = t.replace(/\s/g, "");
  if (/^0*\d{1,10}\/\d{4}$/.test(compact) && !/r\s*\$/i.test(t)) return true;
  return false;
}

const MONETARY_KEYWORDS =
  /\b(milh[oõ]es?|mil\b|bolsa|teto|financiamento|contrapartida|recurso|dotacao|dotação|reais|real\b|us\$|€|orçamento|orcamento|investimento|subvenção|subvencao|auxilio|auxílio|premio|prêmio|pagamento|mensal|anual|limite|maximo|máximo|minimo|mínimo)\b/i;

/** Indica sinais de valor monetário (R$, números por extenso ou termos financeiros). */
export function valorLineHasMonetarySignal(line: string): boolean {
  const t = String(line || "").trim();
  if (!t) return false;
  if (extractBRLAmountsFromText(t).length > 0) return true;
  if (parseWrittenPortugueseMoneyPhrase(t) != null) return true;
  return MONETARY_KEYWORDS.test(t);
}

/** Linha claramente inválida como valor financeiro (nº edital, data pura, só dígitos). */
export function valorLineDefinitelyInvalid(line: string): boolean {
  const t = String(line || "").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (valorLineLooksLikeEditalNumero(t)) return true;
  if (PURE_DATE_LINE.test(t)) return true;
  if (/^\d[\d./\s-]*$/.test(t) && !valorLineHasMonetarySignal(t)) return true;
  return false;
}

/** `valor_projeto` coincide com o número do edital (ex.: `00001946/2026`). */
export function valorMatchesEditalNumero(value: unknown, editalNumero: string | null | undefined): boolean {
  const ref = editalNumero ? normalizeEditalNumeroRef(editalNumero) : null;
  if (!ref) return false;
  return flattenValorProjetoLines(value).some((line) => {
    const lineRef = normalizeEditalNumeroRef(line);
    if (lineRef && lineRef === ref) return true;
    const compact = line.replace(/\s/g, "").toLowerCase();
    const numCompact = String(editalNumero).replace(/\s/g, "").toLowerCase();
    return compact === numCompact;
  });
}

/** Heurística: valor suspeito (nº edital, sem sinal monetário, etc.) — candidato a reextração. */
export function isSuspiciousValorProjeto(value: unknown, editalNumero?: string | null): boolean {
  const lines = flattenValorProjetoLines(value);
  if (lines.length === 0) return true;
  if (editalNumero && valorMatchesEditalNumero(value, editalNumero)) return true;
  if (lines.some((l) => valorLineDefinitelyInvalid(l))) return true;
  if (lines.every((l) => !valorLineHasMonetarySignal(l))) return true;
  return false;
}

/** Heurística rápida (sem LLM): valor plausível para persistir ou considerar útil. */
export function isPlausibleValorProjetoHeuristic(value: unknown, editalNumero?: string | null): boolean {
  const lines = flattenValorProjetoLines(value);
  if (lines.length === 0) return false;
  return !isSuspiciousValorProjeto(value, editalNumero);
}
