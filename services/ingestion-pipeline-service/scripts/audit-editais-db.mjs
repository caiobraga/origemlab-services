/**
 * Auditoria Supabase: editais por fonte vs campos extraídos / PDFs / chunks.
 * Uso: node scripts/audit-editais-db.mjs (cwd: ingestion-pipeline-service)
 */
import { loadEnv } from "../../scraper-runner/src/loadEnv.mjs";
import { createClient } from "@supabase/supabase-js";

loadEnv();

const SOURCES = [
  "finep",
  "rotadofomento",
  "plataforma-inovacao-industria",
  "fapern",
  "capta",
  "fapac",
  "secti",
  "funcap",
  "facepe",
  "fapdf",
  "fapeal",
  "fapema",
  "fapepi",
  "fapergs",
  "faperj",
  "fapesc",
  "fapespa",
  "fapesq",
  "fapitec",
  "fapt",
  "cnpq",
  "fapemig",
  "fapemat",
  "fapes",
  "prosas",
  "sigfapes",
];

function hasText(v) {
  return v != null && String(v).trim().length > 0;
}

function valorLen(v) {
  if (!hasText(v)) return 0;
  return String(v).length;
}

async function main() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY obrigatórios em origemlab-services/.env");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  const { data: editais, error } = await supabase
    .from("editais")
    .select(
      "id,fonte,titulo,numero,valor_projeto,prazo_inscricao,localizacao,sobre_programa,criterios_elegibilidade,informacoes_processadas_em,criado_em,link",
    )
    .order("criado_em", { ascending: false });

  if (error) throw new Error(error.message);

  const rows = editais || [];
  console.log(`\n📊 Total editais no banco: ${rows.length}\n`);

  const byFonte = new Map();
  for (const e of rows) {
    const f = String(e.fonte || "(sem fonte)").trim();
    if (!byFonte.has(f)) {
      byFonte.set(f, {
        total: 0,
        com_valor: 0,
        com_prazo: 0,
        com_sobre: 0,
        com_criterios: 0,
        processados: 0,
        valor_overflow: 0,
        max_valor_len: 0,
        amostra_titulos: [],
      });
    }
    const b = byFonte.get(f);
    b.total += 1;
    if (hasText(e.valor_projeto)) b.com_valor += 1;
    if (hasText(e.prazo_inscricao)) b.com_prazo += 1;
    if (hasText(e.sobre_programa)) b.com_sobre += 1;
    if (hasText(e.criterios_elegibilidade)) b.com_criterios += 1;
    if (e.informacoes_processadas_em) b.processados += 1;
    const vl = valorLen(e.valor_projeto);
    if (vl > 500) b.valor_overflow += 1;
    if (vl > b.max_valor_len) b.max_valor_len = vl;
    if (b.amostra_titulos.length < 2) b.amostra_titulos.push(String(e.titulo || "").slice(0, 70));
  }

  console.log("fonte | total | valor | prazo | sobre | critérios | processados | valor>500c");
  console.log("-".repeat(95));
  for (const src of SOURCES) {
    const b = byFonte.get(src);
    if (!b) {
      console.log(`${src.padEnd(32)} | 0 | — | — | — | — | — | —  ⚠️ sem editais`);
      continue;
    }
    console.log(
      `${src.padEnd(32)} | ${String(b.total).padStart(4)} | ${String(b.com_valor).padStart(4)} | ${String(b.com_prazo).padStart(4)} | ${String(b.com_sobre).padStart(4)} | ${String(b.com_criterios).padStart(5)} | ${String(b.processados).padStart(5)} | ${String(b.valor_overflow).padStart(3)} (max ${b.max_valor_len}c)`,
    );
  }

  const extras = [...byFonte.keys()].filter((k) => !SOURCES.includes(k));
  if (extras.length) {
    console.log("\nOutras fontes no banco:", extras.join(", "));
  }

  const { data: pdfCounts } = await supabase.from("edital_pdfs").select("edital_id");
  const pdfByEdital = new Map();
  for (const r of pdfCounts || []) {
    const id = r.edital_id;
    pdfByEdital.set(id, (pdfByEdital.get(id) || 0) + 1);
  }

  let comPdf = 0;
  let semPdf = 0;
  for (const e of rows) {
    if (pdfByEdital.get(e.id)) comPdf += 1;
    else semPdf += 1;
  }
  console.log(`\n📎 Editais com ≥1 PDF: ${comPdf} | sem PDF: ${semPdf}`);

  const { count: docCount, error: docErr } = await supabase
    .from("documents")
    .select("id", { count: "exact", head: true });
  if (!docErr) console.log(`📄 Linhas em documents (chunks): ${docCount ?? "?"}`);

  const recent = rows.slice(0, 8);
  console.log("\n🕐 Últimos 8 editais (qualquer fonte):");
  for (const e of recent) {
    const pdfs = pdfByEdital.get(e.id) || 0;
    console.log(
      `  [${e.fonte}] ${String(e.titulo || "").slice(0, 55)} | valor=${hasText(e.valor_projeto) ? "sim" : "—"} prazo=${hasText(e.prazo_inscricao) ? "sim" : "—"} pdfs=${pdfs} proc=${e.informacoes_processadas_em ? "sim" : "—"}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
