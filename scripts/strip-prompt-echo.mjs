#!/usr/bin/env node
/**
 * Remove o cabeçalho do prompt ecoado pelo LLM ("Edital: N/A — Título (FONTE) Campo: Localização …")
 * dos campos de texto em `editais_corretos` e `editais`. Idempotente: rodar de novo não muda nada.
 *
 * Mesma lógica de services/{validate,process}-edital-service/src/lib/promptEcho.ts.
 *
 * Uso (de origemlab-services, lê .env / .env.local):
 *   node scripts/strip-prompt-echo.mjs            # dry-run (padrão): lista antes/depois, não grava
 *   node scripts/strip-prompt-echo.mjs --apply    # grava
 *   node scripts/strip-prompt-echo.mjs --table=editais_corretos
 *   node scripts/strip-prompt-echo.mjs --strip-bold   # também tira "**" de descricao/localizacao/vagas/prazo_inscricao
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dir, "../services/validate-edital-service/package.json"));
const { createClient } = require("@supabase/supabase-js");

function loadEnvFile(f) {
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvFile(resolve(__dir, "../.env.local"));
loadEnvFile(resolve(__dir, "../.env"));

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
if (apply && args.includes("--dry-run")) {
  console.error("Use --apply ou --dry-run, não ambos.");
  process.exit(1);
}
const tableArg = args.find((a) => a.startsWith("--table="))?.slice("--table=".length);
const TABLES = tableArg ? [tableArg] : ["editais_corretos", "editais"];
const stripBold = args.includes("--strip-bold");
/**
 * Campos exibidos como texto puro (card do dashboard etc.), onde "**" aparece cru. sobre_programa e
 * criterios_elegibilidade ficam de fora: o detalhe do edital os renderiza como markdown.
 */
const BOLD_FIELDS = new Set(["descricao", "localizacao", "vagas", "prazo_inscricao"]);
const FIELDS = [
  "localizacao",
  "sobre_programa",
  "criterios_elegibilidade",
  "prazo_inscricao",
  "vagas",
  "valor_projeto",
  "descricao",
];

// --- mesma lógica de promptEcho.ts ---------------------------------------------------------------

const FIELD_LABEL = String.raw`(?:localiza[cç][aã]o|vagas?|sobre(?:[\s_]+o)?[\s_]+programa|crit[eé]rios?(?:[\s_]+de)?[\s_]+elegibilidade|prazo(?:[\s_]+de)?[\s_]+inscri[cç][aã]o|valor(?:[\s_]+do)?[\s_]+projeto|timeline(?:[\s_]+estimada)?|is[\s_]+researcher|is[\s_]+company)(?![\p{L}\d_])`;
const FIELD_TAIL = String.raw`\*{0,2}Campo\*{0,2}:\*{0,2}\s*\*{0,2}${FIELD_LABEL}\*{0,2}\s*[.:]?\s*(?:Texto:\s*)?`;
const EDITAL_NUM = String.raw`(?:N\/A|[^\s—–]*\d[^\s—–]*)`;
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

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function editalHeaders(edital) {
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

function stripEchoedPromptHeader(text, edital) {
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

// -------------------------------------------------------------------------------------------------

/** Limpa strings dentro de JSON estruturado (ex.: valor_projeto `{"valor":[...]}`) sem tocar na estrutura. */
function cleanDeep(v, edital) {
  if (typeof v === "string") return stripEchoedPromptHeader(v, edital) || null;
  if (Array.isArray(v)) return v.map((x) => cleanDeep(x, edital)).filter((x) => x !== null);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanDeep(x, edital)]));
  }
  return v;
}

/** Valor limpo, ou `undefined` se não há o que mudar. */
function stripBoldMarkers(s) {
  return s.replace(/\*\*/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

function cleanValue(value, edital, field) {
  if (value == null) return undefined;
  if (typeof value === "object") {
    const next = cleanDeep(value, edital);
    return JSON.stringify(next) === JSON.stringify(value) ? undefined : next;
  }
  if (typeof value !== "string") return undefined;
  const t = value.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      const parsed = JSON.parse(t);
      if (parsed && typeof parsed === "object") {
        const next = cleanDeep(parsed, edital);
        return JSON.stringify(next) === JSON.stringify(parsed) ? undefined : JSON.stringify(next);
      }
    } catch {
      // não é JSON: segue como texto
    }
  }
  let next = stripEchoedPromptHeader(value, edital);
  if (stripBold && BOLD_FIELDS.has(field) && next.includes("**")) next = stripBoldMarkers(next);
  if (next === t) return undefined;
  return next || null;
}

const sb = createClient(url, key);

async function fetchAll(table, columns) {
  const rows = [];
  const page = 1000;
  for (let from = 0; ; from += page) {
    const { data, error } = await sb.from(table).select(columns).order("id").range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < page) break;
  }
  return rows;
}

function preview(v, max = 220) {
  if (v === null) return "null";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return JSON.stringify(s.length > max ? `${s.slice(0, max)}…` : s);
}

const SUSPECT = /\bCampo\s*:|\bEdital:?\s*\S+\s+[—–]\s/i;

async function main() {
  console.log(`\n=== strip-prompt-echo (${apply ? "APPLY — gravando" : "dry-run — nada será gravado"}${stripBold ? ", --strip-bold" : ""}) ===`);
  let totalChanges = 0;
  let totalNulls = 0;
  for (const table of TABLES) {
    const rows = await fetchAll(table, ["id", "numero", "titulo", "fonte", ...FIELDS].join(","));
    const byField = Object.fromEntries(FIELDS.map((f) => [f, 0]));
    const suspects = [];
    let rowsChanged = 0;
    console.log(`\n## ${table} (${rows.length} linhas)\n`);

    for (const row of rows) {
      const patch = {};
      for (const field of FIELDS) {
        const before = row[field];
        const after = cleanValue(before, row, field);
        const finalValue = after === undefined ? before : after;
        if (typeof finalValue === "string" && SUSPECT.test(finalValue)) {
          suspects.push(`${row.id} ${field}: ${preview(finalValue)}`);
        }
        if (after === undefined) continue;
        patch[field] = after;
        byField[field]++;
        totalChanges++;
        if (after === null) totalNulls++;
        console.log(`${row.id}  ${field}${after === null ? "  (→ null: só havia cabeçalho)" : ""}`);
        console.log(`  antes:  ${preview(before)}`);
        console.log(`  depois: ${preview(after)}`);
      }
      if (Object.keys(patch).length === 0) continue;
      rowsChanged++;
      if (apply) {
        const { error } = await sb.from(table).update(patch).eq("id", row.id);
        if (error) throw new Error(`${table} ${row.id}: ${error.message}`);
      }
    }

    const counts = Object.entries(byField)
      .filter(([, n]) => n > 0)
      .map(([f, n]) => `${f} ${n}`)
      .join(", ");
    console.log(`\n${table}: ${rowsChanged} linhas / ${Object.values(byField).reduce((a, b) => a + b, 0)} valores${counts ? ` (${counts})` : ""}`);
    if (suspects.length) {
      console.log(`\n${table}: ${suspects.length} valores ainda parecem conter cabeçalho (revisar à mão):`);
      for (const s of suspects) console.log(`  ${s}`);
    }
  }
  console.log(
    `\nTotal: ${totalChanges} valores${totalNulls ? ` (${totalNulls} viram null)` : ""}${apply ? " gravados." : ". Rode com --apply para gravar."}\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
