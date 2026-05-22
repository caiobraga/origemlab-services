/**
 * PDFs e extração por fonte (complemento ao audit-editais-db).
 */
import { loadEnv } from "../src/loadEnv.mjs";
import { createClient } from "@supabase/supabase-js";

loadEnv();

const SOURCES = [
  "finep", "rotadofomento", "plataforma-inovacao-industria", "fapern", "capta", "fapac",
  "secti", "funcap", "facepe", "fapdf", "fapeal", "fapema", "fapepi", "fapergs", "faperj",
  "fapesc", "fapespa", "fapesq", "fapitec", "fapt",
  "cnpq", "fapemig", "fapemat", "fapes", "prosas", "sigfapes",
];

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: editais } = await supabase.from("editais").select("id,fonte,titulo,valor_projeto,prazo_inscricao,informacoes_processadas_em");
  let allPdfs = [];
  let from = 0;
  while (true) {
    const { data } = await supabase.from("edital_pdfs").select("edital_id,is_processed").range(from, from + 999);
    if (!data?.length) break;
    allPdfs = allPdfs.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const pdfs = allPdfs;

  const pdfMap = new Map();
  for (const p of pdfs || []) {
    const cur = pdfMap.get(p.edital_id) || { total: 0, processed: 0 };
    cur.total += 1;
    if (p.is_processed) cur.processed += 1;
    pdfMap.set(p.edital_id, cur);
  }

  const byFonte = new Map();
  for (const e of editais || []) {
    const f = e.fonte || "?";
    if (!byFonte.has(f)) byFonte.set(f, { total: 0, com_pdf: 0, pdf_proc: 0, sem_valor: 0, sem_prazo: 0, nao_processado: 0 });
    const b = byFonte.get(f);
    b.total += 1;
    const p = pdfMap.get(e.id);
    if (p?.total) { b.com_pdf += 1; if (p.processed >= p.total) b.pdf_proc += 1; }
    if (!e.valor_projeto?.trim()) b.sem_valor += 1;
    if (!e.prazo_inscricao?.trim()) b.sem_prazo += 1;
    if (!e.informacoes_processadas_em) b.nao_processado += 1;
  }

  console.log("\nfonte | editais | c/ PDF | PDF ok | sem valor | sem prazo | sem process-edital");
  console.log("-".repeat(88));
  for (const s of SOURCES) {
    const b = byFonte.get(s);
    if (!b) { console.log(`${s.padEnd(32)} | 0`); continue; }
    console.log(
      `${s.padEnd(32)} | ${String(b.total).padStart(5)} | ${String(b.com_pdf).padStart(5)} | ${String(b.pdf_proc).padStart(6)} | ${String(b.sem_valor).padStart(8)} | ${String(b.sem_prazo).padStart(8)} | ${String(b.nao_processado).padStart(6)}`,
    );
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
