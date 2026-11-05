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

  // "R$ 10 milhões", "R$ 1,5 milhão", "R$ 600 mil" (o padrão acima só pega o "10"/"600").
  for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:milhões|milhoes|milhão|milhao)\b/gi)) {
    const base = parseBrazilianMoneyToken(m[1].replace(",", "."));
    if (base) amounts.push(base * 1_000_000);
  }
  for (const m of s.matchAll(/(\d+(?:[.,]\d+)?)\s*mil\b/gi)) {
    const base = parseBrazilianMoneyToken(m[1].replace(",", "."));
    if (base) amounts.push(base * 1_000);
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
    const estruturado = parseValorProjetoEstruturado(obj);
    if (estruturado) {
      return [
        ...estruturado.valor,
        ...estruturado.bolsas,
        ...(estruturado.total_programa_texto ? [estruturado.total_programa_texto] : []),
      ];
    }
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

// ---------------------------------------------------------------------------
// valor_projeto estruturado: valor por projeto × orçamento total da chamada
// ---------------------------------------------------------------------------

/**
 * Formato gravado em `editais.valor_projeto` (string JSON) pela extração estruturada.
 * `valor` só tem o valor elegível POR PROJETO/PROPOSTA (teto ou faixa); o orçamento global da
 * chamada fica em `total_programa*` e nunca deve ser exibido como valor por projeto.
 * A presença de `por_projeto_origem` marca o formato (linhas antigas só têm `{ valor: [...] }`).
 */
export type ValorProjetoEstruturado = {
  valor: string[];
  /** Valores por bolsa/beneficiário (ex.: "bolsa DTI R$ 3.000/mês"); não entram no teto por projeto. */
  bolsas: string[];
  por_projeto_min: number | null;
  por_projeto_max: number | null;
  /** "edital" = o texto define o valor por projeto; "projeto_unico" = total da chamada com 1 projeto apoiado. */
  por_projeto_origem: "edital" | "projeto_unico" | null;
  total_programa: number | null;
  total_programa_texto: string | null;
  qtd_projetos: number | null;
};

const TOTAL_PROGRAMA_RE =
  /\b(global|total|totaliza\w*|dota[cç][aã]o|or[cç]amento|montante|capital comprometido|investimento|recursos?\s+(?:financeiros?\s+)?(?:totais|dispon[ií]ve(?:l|is)|destinados?|previstos?|alocados?))\b/i;
const POR_PROJETO_RE =
  /\b(?:por|cada|para cada)\s+(?:projeto|proposta|empresa|startup|benefici[aá]ri\w*|pesquisador\w*|bolsista|plano|iniciativa|institui[cç][aã]o|ict|grupo|evento|candidat\w*|subprojeto)|\bcada\b|\bindividua\w*/i;
const MOEDA_ESTRANGEIRA_RE = /€|\beuros?\b|us\$|\busd\b|d[oó]lar|£|\blibras?\b/i;
const FAIXA_MIN_RE = /m[ií]nimo|\bentre\b|\bde\s+r\$[^;]*?\ba\s+r\$/i;
const MENSAL_RE = /\/\s*m[eê]s\b|\bmensa(?:l|is)\b|\bao\s+m[eê]s\b|\bpor\s+m[eê]s\b/i;

/** Linha cita algum valor (R$, por extenso ou moeda estrangeira com número). */
function valorLineHasAmount(line: string): boolean {
  return extractBRLAmountsFromText(line).length > 0 || (MOEDA_ESTRANGEIRA_RE.test(line) && /\d/.test(line));
}

const ESTRUTURADO_LINE_MAX = 200;
const ESTRUTURADO_LINES_MAX = 6;

function cleanValorLine(raw: unknown, max = ESTRUTURADO_LINE_MAX): string | null {
  if (raw == null) return null;
  const t = String(raw).replace(/\s+/g, " ").trim();
  if (!t || /^(null|n[aã]o informado)$/i.test(t)) return null;
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function toValorLines(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  const out: string[] = [];
  for (const x of list) {
    const v = x && typeof x === "object" && "valor" in (x as object) ? (x as { valor: unknown }).valor : x;
    const t = typeof v === "string" || typeof v === "number" ? cleanValorLine(v) : null;
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** Valores em R$ (≥ R$ 100) de uma linha; linhas em moeda estrangeira não contam. */
function brlAmountsOfLine(line: string): number[] {
  if (MOEDA_ESTRANGEIRA_RE.test(line)) return [];
  return extractBRLAmountsFromText(line).filter((n) => n >= 100);
}

function toPositiveNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw > 0 ? raw : null;
  if (typeof raw === "string") {
    const fromText = brlAmountsOfLine(raw);
    if (fromText.length) return Math.max(...fromText);
    const n = parseBrazilianMoneyToken(raw.replace(/[^\d.,]/g, ""));
    return n && n > 0 ? n : null;
  }
  return null;
}

function toQtdProjetos(raw: unknown): number | null {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw.replace(/\D/g, ""), 10) : NaN;
  return Number.isInteger(n) && n > 0 && n <= 100_000 ? n : null;
}

function formatBRL(n: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 2 }).format(n);
}

/** Lê o formato estruturado já gravado (string JSON ou objeto); `null` para formato antigo/texto. */
export function parseValorProjetoEstruturado(value: unknown): ValorProjetoEstruturado | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof value === "string") {
    const t = value.trim();
    obj = t.startsWith("{") ? safeParseJsonObject(t) : null;
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    obj = value as Record<string, unknown>;
  }
  if (!obj || !("por_projeto_origem" in obj)) return null;
  const origem = obj.por_projeto_origem;
  return {
    valor: toValorLines(obj.valor),
    bolsas: toValorLines(obj.bolsas),
    por_projeto_min: typeof obj.por_projeto_min === "number" ? obj.por_projeto_min : null,
    por_projeto_max: typeof obj.por_projeto_max === "number" ? obj.por_projeto_max : null,
    por_projeto_origem: origem === "edital" || origem === "projeto_unico" ? origem : null,
    total_programa: typeof obj.total_programa === "number" ? obj.total_programa : null,
    total_programa_texto: cleanValorLine(obj.total_programa_texto),
    qtd_projetos: toQtdProjetos(obj.qtd_projetos),
  };
}

export function isValorProjetoEstruturado(value: unknown): boolean {
  return parseValorProjetoEstruturado(value) != null;
}

/** Há valor por projeto (ou por bolsa) — e não só o orçamento total da chamada. Formato antigo conta como sim. */
export function valorProjetoTemPorProjeto(value: unknown): boolean {
  const e = parseValorProjetoEstruturado(value);
  if (!e) return flattenValorProjetoLines(value).length > 0;
  return e.valor.length > 0 || e.bolsas.length > 0;
}

/**
 * Converte a resposta do modelo (`{por_projeto, por_projeto_min, total_programa, qtd_projetos, bolsas}`
 * ou o formato antigo `{valor:[...]}`) no formato estruturado gravado.
 * - Com `contextText`, descarta linhas/valores cujos números em R$ não aparecem no contexto.
 * - Linhas de "valor por projeto" que falam de total/global/dotação (sem "por projeto"/"cada")
 *   são movidas para o total da chamada.
 * - Só total + 1 projeto apoiado ⇒ o total é o valor do projeto (`por_projeto_origem: "projeto_unico"`).
 *   Com mais projetos, o valor por projeto não é derivado (seria média, não teto).
 */
export function normalizeValorProjetoEstruturado(
  raw: unknown,
  opts: { contextText?: string } = {},
): ValorProjetoEstruturado | null {
  const stored = parseValorProjetoEstruturado(raw);
  if (stored) return stored;

  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return null;
    obj = t.startsWith("{") ? safeParseJsonObject(t) : { por_projeto: extractValorLinesForStorage(t) };
  } else if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    obj = raw as Record<string, unknown>;
  } else if (Array.isArray(raw)) {
    obj = { por_projeto: raw };
  }
  if (!obj) return null;

  let linhas = toValorLines(obj.por_projeto ?? obj.valor);
  let bolsas = toValorLines(obj.bolsas);
  let totalTexto =
    cleanValorLine(obj.total_programa_texto) ??
    (typeof obj.total_programa === "string" ? cleanValorLine(obj.total_programa) : null);
  const qtd = toQtdProjetos(obj.qtd_projetos);

  const ctx = String(opts.contextText || "");
  const ctxAmounts = ctx.trim() ? extractBRLAmountsFromText(ctx) : null;
  const inContext = (n: number) => !ctxAmounts || ctxAmounts.some((c) => amountsAreNear(c, n));
  const lineSupported = (l: string) => {
    const nums = brlAmountsOfLine(l);
    return nums.length === 0 || nums.some(inContext);
  };
  linhas = linhas.filter(lineSupported);
  bolsas = bolsas.filter(lineSupported);

  // Valor mensal (bolsa/mensalidade) não é teto por projeto; e bolsa sem valor não informa nada.
  const mensais = linhas.filter((l) => MENSAL_RE.test(l));
  if (mensais.length) {
    linhas = linhas.filter((l) => !mensais.includes(l));
    bolsas = [...bolsas, ...mensais.filter((l) => !bolsas.includes(l))];
  }
  bolsas = bolsas.filter((l) => valorLineHasAmount(l));

  // O modelo às vezes repete a bolsa sem rótulo ("R$ 3.900,00") em por_projeto ou duas vezes em bolsas.
  const repeteValores = (l: string, ref: string[]) => {
    const nums = brlAmountsOfLine(l);
    const refNums = ref.flatMap(brlAmountsOfLine);
    return nums.length > 0 && nums.every((n) => refNums.some((r) => amountsAreNear(r, n)));
  };
  linhas = linhas.filter((l) => !repeteValores(l, bolsas));
  bolsas = bolsas.filter((l, i) => !repeteValores(l, bolsas.slice(0, i)));
  if (totalTexto && !lineSupported(totalTexto)) totalTexto = null;

  // Linhas "por projeto" que na verdade descrevem o orçamento global da chamada.
  const movidas = linhas.filter((l) => TOTAL_PROGRAMA_RE.test(l) && !POR_PROJETO_RE.test(l));
  if (movidas.length) {
    linhas = linhas.filter((l) => !movidas.includes(l));
    totalTexto ??= movidas[0]!;
  }

  let total: number | null = null;
  if (totalTexto) {
    const nums = brlAmountsOfLine(totalTexto);
    if (nums.length) total = Math.max(...nums);
  } else if (typeof obj.total_programa === "number" && inContext(obj.total_programa)) {
    total = obj.total_programa;
    totalTexto = formatBRL(total);
  }

  let perAmounts = linhas.flatMap(brlAmountsOfLine);
  if (total != null && perAmounts.some((n) => !amountsAreNear(n, total!))) {
    // Ex.: "R$ 150.000,00 cada, totalizando R$ 300.000,00" — o total não é teto por projeto.
    perAmounts = perAmounts.filter((n) => !amountsAreNear(n, total!));
  } else if (total != null && perAmounts.length > 0 && qtd !== 1) {
    // Valor "por projeto" == total sem o edital dizer que apoia 1 projeto: o modelo repetiu o total.
    linhas = [];
    perAmounts = [];
  }

  let max = perAmounts.length ? Math.max(...perAmounts) : null;
  let min: number | null = null;
  const llmMin = toPositiveNumber(obj.por_projeto_min);
  if (llmMin != null && max != null && llmMin < max && inContext(llmMin)) min = llmMin;
  else if (perAmounts.length >= 2 && linhas.some((l) => FAIXA_MIN_RE.test(l))) min = Math.min(...perAmounts);
  if (max == null && perAmounts.length === 0 && linhas.some((l) => !MOEDA_ESTRANGEIRA_RE.test(l))) {
    const llmMax = toPositiveNumber(obj.por_projeto_max);
    if (llmMax != null && inContext(llmMax)) max = llmMax;
  }

  // Total menor que o teto por projeto é incoerente (parcela de um financiador, leitura errada): descarta.
  if (total != null && max != null && total < max) {
    total = null;
    totalTexto = null;
  }

  let origem: ValorProjetoEstruturado["por_projeto_origem"] = linhas.length ? "edital" : null;
  if (!linhas.length && total != null && qtd === 1) {
    linhas = [`até ${formatBRL(total)} (projeto único apoiado pela chamada)`];
    max = total;
    origem = "projeto_unico";
  }

  if (!linhas.length && !bolsas.length && !totalTexto) return null;
  return {
    valor: linhas.slice(0, ESTRUTURADO_LINES_MAX),
    bolsas: bolsas.slice(0, ESTRUTURADO_LINES_MAX),
    por_projeto_min: min,
    por_projeto_max: max,
    por_projeto_origem: origem,
    total_programa: total,
    total_programa_texto: totalTexto,
    qtd_projetos: qtd,
  };
}

/** Completa `a` com o que só `b` tem (ex.: um lote trouxe o total, outro o teto por projeto). */
export function mergeValorProjetoEstruturado(
  a: ValorProjetoEstruturado,
  b: ValorProjetoEstruturado,
): ValorProjetoEstruturado {
  const porProjeto = a.valor.length ? a : b.valor.length ? b : a;
  const totalSrc = a.total_programa_texto ? a : b;
  return {
    valor: porProjeto.valor,
    bolsas: [...new Set([...a.bolsas, ...b.bolsas])].slice(0, ESTRUTURADO_LINES_MAX),
    por_projeto_min: porProjeto.por_projeto_min,
    por_projeto_max: porProjeto.por_projeto_max,
    por_projeto_origem: porProjeto.por_projeto_origem,
    total_programa: totalSrc.total_programa,
    total_programa_texto: totalSrc.total_programa_texto,
    qtd_projetos: a.qtd_projetos ?? b.qtd_projetos,
  };
}

export function serializeValorProjetoEstruturado(e: ValorProjetoEstruturado): string {
  return JSON.stringify(e);
}
