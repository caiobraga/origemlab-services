#!/usr/bin/env node
/**
 * Resumo do funil editais → editais_corretos (diagnóstico de throughput).
 * Uso (a partir de origemlab-backend com .env.local):
 *   node ../origemlab-services/scripts/audit-edital-pipeline-funnel.mjs
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

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key);

async function count(table, filter = (q) => q) {
  const { count, error } = await filter(sb.from(table).select("*", { count: "exact", head: true }));
  if (error) throw error;
  return count ?? 0;
}

async function main() {
  const total = await count("editais");
  const pdfOk = await count("editais", (q) => q.not("processado_em", "is", null));
  const infoOk = await count("editais", (q) => q.not("informacoes_processadas_em", "is", null));
  const infoPending = await count("editais", (q) => q.is("informacoes_processadas_em", null));
  const corretos = await count("editais_corretos");
  const pdfs = await count("edital_pdfs");
  const docs = await count("documents");

  const backlog = Math.max(0, infoOk - corretos);

  console.log("\n=== Funil Origem.Lab ===\n");
  console.log(`editais (bruto)              ${total}`);
  console.log(`  com PDF processado         ${pdfOk} (${pct(pdfOk, total)})`);
  console.log(`  com info extraída (IA)     ${infoOk} (${pct(infoOk, total)})`);
  console.log(`  pendentes process-edital   ${infoPending}`);
  console.log(`editais_corretos (catálogo)  ${corretos} (${pct(corretos, total)})`);
  console.log(`backlog validate (~)         ${backlog}`);
  console.log(`edital_pdfs                  ${pdfs}`);
  console.log(`documents (chunks)           ${docs}`);
  console.log("\nDashboard mostra editais_corretos, não o total bruto.");
  console.log("Gargalo típico: validate (Ollama) + regras prazo_encerrado + falta de documents.\n");
}

function pct(n, d) {
  if (!d) return "0%";
  return `${Math.round((100 * n) / d)}%`;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
