#!/usr/bin/env node
/**
 * Limpa `informacoes_processadas_em` de editais fora de editais_corretos que foram
 * marcados como processados sem campos úteis (bloqueiam validate e atrasam o funil).
 *
 * Uso (a partir de origemlab-backend com .env.local):
 *   node ../origemlab-services/scripts/reprocess-edital-backlog.mjs
 *   node ../origemlab-services/scripts/reprocess-edital-backlog.mjs --apply
 *   node ../origemlab-services/scripts/reprocess-edital-backlog.mjs --apply --with-chunks-only
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dir, "../../origemlab-backend/package.json"));
const { createClient } = require("@supabase/supabase-js");
const backendEnv = resolve(__dir, "../../origemlab-backend/.env.local");
const servicesEnv = resolve(__dir, "../.env.local");

function loadEnvFile(f) {
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i);
    const v = t.slice(i + 1);
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvFile(servicesEnv);
loadEnvFile(backendEnv);

const apply = process.argv.includes("--apply");
const withChunksOnly = process.argv.includes("--with-chunks-only");

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key);

const EXTRACTED_FIELDS = [
  "valor_projeto",
  "prazo_inscricao",
  "localizacao",
  "vagas",
  "is_researcher",
  "is_company",
  "sobre_programa",
  "criterios_elegibilidade",
  "timeline_estimada",
];

function hasMeaningfulValue(field, value) {
  if (value === null || value === undefined) return false;
  if (field === "is_researcher" || field === "is_company") return typeof value === "boolean";
  if (field === "timeline_estimada") {
    const tl = value && typeof value === "object" ? value : null;
    return Boolean(tl && Array.isArray(tl.fases) && tl.fases.length > 0);
  }
  if (field === "valor_projeto") {
    const t = String(value).trim().toLowerCase();
    return Boolean(t && t !== "não informado" && t !== "nao informado" && t !== "null");
  }
  const t = String(value).replace(/\s+/g, " ").trim().toLowerCase();
  return Boolean(
    t &&
      t !== "null" &&
      t !== "não informado" &&
      t !== "nao informado" &&
      t !== "não informado pelo edital" &&
      t !== "nao informado pelo edital",
  );
}

function hasUsefulFields(row) {
  return EXTRACTED_FIELDS.some((f) => hasMeaningfulValue(f, row[f]));
}

async function loadCorretosIds() {
  const { data, error } = await sb.from("editais_corretos").select("id");
  if (error) throw error;
  return new Set((data ?? []).map((r) => String(r.id)));
}

async function loadChunkEditalIds() {
  const { data, error } = await sb.rpc("process_edital_editais_com_document_chunks");
  if (error) {
    console.warn(`RPC chunks indisponível: ${error.message}`);
    return null;
  }
  return new Set((data ?? []).map((r) => String(r.edital_id)).filter(Boolean));
}

async function main() {
  const corretos = await loadCorretosIds();
  const chunkIds = withChunksOnly ? await loadChunkEditalIds() : null;
  if (withChunksOnly && (!chunkIds || chunkIds.size === 0)) {
    console.error("Sem RPC de chunks — remova --with-chunks-only ou aplique a migration SQL.");
    process.exit(1);
  }

  const selectCols = `id,numero,titulo,fonte,informacoes_processadas_em,${EXTRACTED_FIELDS.join(",")}`;
  const candidates = [];
  let from = 0;
  const pageSize = 500;

  for (;;) {
    const { data, error } = await sb
      .from("editais")
      .select(selectCols)
      .not("informacoes_processadas_em", "is", null)
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = data ?? [];
    for (const row of batch) {
      if (corretos.has(row.id)) continue;
      if (hasUsefulFields(row)) continue;
      if (chunkIds && !chunkIds.has(row.id)) continue;
      candidates.push(row);
    }
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  console.log("\n=== Reprocess backlog (stamp falso) ===\n");
  console.log(`Modo: ${apply ? "APLICAR reset" : "dry-run (use --apply)"}`);
  console.log(`Filtro chunks: ${withChunksOnly ? "sim" : "não"}`);
  console.log(`Candidatos: ${candidates.length}`);
  if (candidates.length > 0) {
    console.log("Exemplos:");
    for (const e of candidates.slice(0, 5)) {
      console.log(`  - ${e.numero || e.id.slice(0, 8)} | ${e.titulo?.slice(0, 60)} (${e.fonte})`);
    }
  }

  if (!apply || candidates.length === 0) {
    console.log(
      "\nPróximo passo: rodar pipeline com PROCESS_EDITAL_BACKLOG_ONLY=1 PROCESS_EDITAL_CHUNKS_ONLY=1",
    );
    return;
  }

  let reset = 0;
  const chunk = 40;
  for (let i = 0; i < candidates.length; i += chunk) {
    const slice = candidates.slice(i, i + chunk);
    const ids = slice.map((r) => r.id);
    const { error } = await sb
      .from("editais")
      .update({ informacoes_processadas_em: null })
      .in("id", ids);
    if (error) throw error;
    reset += ids.length;
    process.stdout.write(`\rResetados: ${reset}/${candidates.length}`);
  }
  console.log("\n\n✅ informacoes_processadas_em limpo. Rode document-processor + process-edital + validate.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
