/**
 * Corrige títulos já gravados no Supabase (adendo, "03/2026 -", resultados, etc.).
 * Uso (cwd: ingestion-pipeline-service):
 *   node scripts/fix-bad-titles.mjs [--dry-run]
 */
import { loadEnv } from "../../scraper-runner/src/loadEnv.mjs";
import { createClient } from "@supabase/supabase-js";
import {
  buildEditalTitulo,
  isSupplementTitle,
  isWeakLinkTitle,
  stripLinkPrefix,
} from "../../scraper-runner/src/scraperTitleUtils.mjs";

loadEnv();

const dryRun = process.argv.includes("--dry-run");

function proposedTitle(e) {
  const numero = e.numero ? String(e.numero).trim() : "";
  const raw = stripLinkPrefix(e.titulo);
  if (!isSupplementTitle(raw) && !isWeakLinkTitle(raw) && raw.length >= 12) return null;
  if (!numero) return null;
  return buildEditalTitulo({ linkText: raw, numero, fonte: e.fonte });
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios em origemlab-services/.env");
    process.exit(1);
  }
  const sb = createClient(url, key);
  const { data, error } = await sb.from("editais").select("id,fonte,titulo,numero");
  if (error) throw new Error(error.message);

  const fixes = [];
  for (const e of data || []) {
    const next = proposedTitle(e);
    if (next && next !== e.titulo) {
      fixes.push({ id: e.id, fonte: e.fonte, from: e.titulo, to: next, numero: e.numero });
    }
  }

  console.log(`\n🔧 Correções propostas: ${fixes.length}${dryRun ? " (dry-run)" : ""}\n`);
  for (const f of fixes.slice(0, 30)) {
    console.log(`[${f.fonte}] ${f.numero}`);
    console.log(`  - de: ${String(f.from).slice(0, 90)}`);
    console.log(`  + para: ${f.to}\n`);
  }
  if (fixes.length > 30) console.log(`... +${fixes.length - 30} mais`);

  if (dryRun || fixes.length === 0) return;

  let ok = 0;
  for (const f of fixes) {
    const { error: upErr } = await sb.from("editais").update({ titulo: f.to }).eq("id", f.id);
    if (upErr) console.error("erro", f.id, upErr.message);
    else ok += 1;
  }
  console.log(`\n✅ Atualizados: ${ok}/${fixes.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
