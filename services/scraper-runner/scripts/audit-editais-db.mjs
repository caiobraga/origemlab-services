/**
 * Auditoria Supabase: editais por fonte vs campos extraídos.
 */
import { loadEnv } from "../src/loadEnv.mjs";
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
      });
    }
    const b = byFonte.get(f);
    b.total += 1;
    if (hasText(e.valor_projeto)) b.com_valor += 1;
    if (hasText(e.prazo_inscricao)) b.com_prazo += 1;
    if (hasText(e.sobre_programa)) b.com_sobre += 1;
    if (hasText(e.criterios_elegibilidade)) b.com_criterios += 1;
    if (e.informacoes_processadas_em) b.processados += 1;
    const vl = hasText(e.valor_projeto) ? String(e.valor_projeto).length : 0;
    if (vl > 500) b.valor_overflow += 1;
    if (vl > b.max_valor_len) b.max_valor_len = vl;
  }

  console.log("fonte | total | valor | prazo | sobre | critérios | processados | valor>500c");
  console.log("-".repeat(95));
  for (const src of SOURCES) {
    const b = byFonte.get(src);
    if (!b) {
      console.log(`${src.padEnd(32)} |    0 |   — |   — |   — |     — |     — | —  ⚠️ sem editais`);
      continue;
    }
    console.log(
      `${src.padEnd(32)} | ${String(b.total).padStart(4)} | ${String(b.com_valor).padStart(4)} | ${String(b.com_prazo).padStart(4)} | ${String(b.com_sobre).padStart(4)} | ${String(b.com_criterios).padStart(5)} | ${String(b.processados).padStart(5)} | ${String(b.valor_overflow).padStart(3)} (max ${b.max_valor_len}c)`,
    );
  }

  const { data: pdfRows } = await supabase.from("edital_pdfs").select("edital_id");
  const pdfByEdital = new Map();
  for (const r of pdfRows || []) {
    pdfByEdital.set(r.edital_id, (pdfByEdital.get(r.edital_id) || 0) + 1);
  }

  let comPdf = 0;
  for (const e of rows) {
    if (pdfByEdital.get(e.id)) comPdf += 1;
  }
  console.log(`\n📎 Editais com ≥1 PDF: ${comPdf} | sem PDF: ${rows.length - comPdf}`);

  const { count: docCount } = await supabase.from("documents").select("id", { count: "exact", head: true });
  console.log(`📄 Chunks em documents: ${docCount ?? "?"}`);

  console.log("\n🕐 Últimos 10 editais:");
  for (const e of rows.slice(0, 10)) {
    console.log(
      `  [${e.fonte}] ${String(e.titulo || "").slice(0, 50)} | v=${hasText(e.valor_projeto) ? "✓" : "—"} p=${hasText(e.prazo_inscricao) ? "✓" : "—"} pdf=${pdfByEdital.get(e.id) || 0} proc=${e.informacoes_processadas_em ? "✓" : "—"}`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
