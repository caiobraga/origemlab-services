/**
 * Remove o cabeçalho do prompt ("Edital: <numero> — <titulo> (<fonte>) Campo: <rótulo> Texto:") que o LLM
 * às vezes ecoa dentro do valor extraído/polido. Ex.:
 *   "Edital: N/A — Chamada Rio Doce Participativo (BNDES) Campo: Localização Bacia do Rio Doce"
 *   → "Bacia do Rio Doce"
 *
 * Mantido idêntico em validate-edital-service e process-edital-service (src/lib/promptEcho.ts);
 * a mesma lógica está em scripts/strip-prompt-echo.mjs (limpeza dos dados já gravados).
 */

export type PromptEchoContext = {
  numero?: string | null;
  titulo?: string | null;
  fonte?: string | null;
};

/** Rótulos de campo como o modelo costuma ecoá-los: chave crua ("sobre_programa") ou humanizada ("Critérios de Elegibilidade"). */
const FIELD_LABEL = String.raw`(?:localiza[cç][aã]o|vagas?|sobre(?:[\s_]+o)?[\s_]+programa|crit[eé]rios?(?:[\s_]+de)?[\s_]+elegibilidade|prazo(?:[\s_]+de)?[\s_]+inscri[cç][aã]o|valor(?:[\s_]+do)?[\s_]+projeto|timeline(?:[\s_]+estimada)?|is[\s_]+researcher|is[\s_]+company)(?![\p{L}\d_])`;

/** "Campo: <rótulo>" (com ou sem negrito markdown), seguido de "Texto:" opcional. */
const FIELD_TAIL = String.raw`\*{0,2}Campo\*{0,2}:\*{0,2}\s*\*{0,2}${FIELD_LABEL}\*{0,2}\s*[.:]?\s*(?:Texto:\s*)?`;

/** Número do edital como aparece no prompt: "N/A" ou um token com dígito ("19/2025", "FAPESPA-9"). */
const EDITAL_NUM = String.raw`(?:N\/A|[^\s—–]*\d[^\s—–]*)`;

/**
 * "Edital: <numero> — <titulo> (<fonte>) Campo: <rótulo>" em qualquer posição. Sem os dois-pontos após
 * "Edital" exige o travessão, para não casar com menções legítimas ("o Edital 05/2020 prevê...").
 */
const HEADER_WITH_FIELD = new RegExp(
  String.raw`\bEdital(?::\s*${EDITAL_NUM}\s*(?:[—–-]\s*)?|\s+${EDITAL_NUM}\s*[—–-]\s*)[\s\S]{0,500}?${FIELD_TAIL}`,
  "giu",
);

/** "Campo: <rótulo>" solto, sem o "Edital:" antes. */
const BARE_FIELD_TAIL = new RegExp(FIELD_TAIL, "giu");

/** Instruções do prompt de polish que o modelo já devolveu dentro do texto. */
const INSTRUCTION_ECHOES = [
  "Você melhora a redação do texto abaixo para publicação em portal de editais, com clareza e tom neutro.",
  "Preserve números, datas, valores monetários e nomes próprios exatamente quando forem factuais no texto original.",
  "Não acrescente fatos novos. Se já estiver claro, devolva com ajustes mínimos de gramática e pontuação.",
];

const LEADING_TEXT_LABEL = /^\s*Texto:\s*/iu;
const MARK = "\u0000";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Cabeçalhos só reconhecíveis com os metadados do edital. Sem "Campo:" ("Edital: 44/2026 — TÍTULO (FAPESC)"):
 * exige "Edital:" + o número real (ou N/A) e termina na fonte entre parênteses.
 */
function editalHeaders(edital: PromptEchoContext): RegExp[] {
  const numero = String(edital.numero ?? "").trim();
  const fonte = String(edital.fonte ?? "").trim() || "N/A";
  const num = numero ? `(?:${escapeRegExp(numero)}|N\\/A)` : String.raw`N\/A`;
  const headers = [
    new RegExp(
      String.raw`\bEdital:\s*${num}\s*(?:[—–-]\s*)?[\s\S]{0,500}?\(\s*${escapeRegExp(fonte)}\s*\)\.?\s*(?:${FIELD_TAIL})?`,
      "giu",
    ),
  ];
  // Sem "Edital:": "FAPESPA-14 — Título. Campo: localização".
  if (numero && numero !== "N/A") {
    headers.push(
      new RegExp(String.raw`(?<![\p{L}\d])${escapeRegExp(numero)}\s*[—–-]\s*[\s\S]{0,500}?${FIELD_TAIL}`, "giu"),
    );
  }
  return headers;
}

/**
 * Devolve o texto sem o cabeçalho ecoado (string vazia se só havia cabeçalho). O restante do texto não é
 * alterado; apenas o ponto do corte vira um espaço.
 */
export function stripEchoedPromptHeader(text: string, edital?: PromptEchoContext | null): string {
  let out = text.replace(HEADER_WITH_FIELD, MARK);
  for (const re of edital ? editalHeaders(edital) : []) out = out.replace(re, MARK);
  out = out.replace(BARE_FIELD_TAIL, MARK);
  for (const line of INSTRUCTION_ECHOES) out = out.split(line).join(MARK);
  if (out.includes(MARK)) {
    out = out
      .replace(new RegExp(`(?:\\s*${MARK})+\\s*`, "g"), " ")
      .replace(/^[\s.:;,—–-]+/u, "")
      .replace(/[\s:;,—–-]+$/u, "");
  }
  return out.replace(LEADING_TEXT_LABEL, "").trim();
}
