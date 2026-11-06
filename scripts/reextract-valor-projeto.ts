/**
 * Reextrai `valor_projeto` no formato estruturado (valor por projeto × total da chamada) para editais
 * já processados, usando o mesmo caminho do process-edital (top-k nos trechos de `documents`).
 * Por padrão só mostra antes/depois (dry-run); `--write` grava em `editais` e `editais_corretos`.
 *
 * Seleção (uma delas):
 *   --ids <id1,id2,...>   editais específicos
 *   --suspeitos           valor_projeto no formato antigo que cita total/global/dotação/milhões
 *   --legado              todo valor_projeto no formato antigo (com PDF processado)
 * Opções: --so-corretos (só editais em editais_corretos), --limit N, --out <arquivo.json>, --write
 * Quando a reextração não encontra valor, o valor antigo é mantido (aparece como "nao_encontrado" no relatório).
 *
 * Uso (de origemlab-services/services/process-edital-service, para o .env do services ser carregado;
 * as variáveis repetem a config do Worker de produção — o .env local usa outro modelo):
 *   OPENROUTER_CHAT_MODEL=qwen/qwen3-30b-a3b PROCESS_EDITAL_TOP_K=12 PROCESS_EDITAL_TOPK_SPLIT=0 \
 *   PROCESS_EDITAL_FULLDOC_CHUNK_SCAN=0 DISABLE_EVENTBRIDGE=1 \
 *   ../../../scripts/run-with-nvm.sh ../../../cloudflare/pipeline/node_modules/.bin/tsx \
 *   ../../scripts/reextract-valor-projeto.ts --suspeitos --limit 20 --out /tmp/valor.json
 */
import { writeFileSync } from "node:fs";
import { extractValorProjetoForEdital } from "../services/process-edital-service/src/api/processEditalInfo.ts";
import { createSupabase } from "../services/process-edital-service/src/lib/supabase";
import { isValorProjetoEstruturado } from "../shared/editalValorExtract.ts";

const args = process.argv.slice(2);
const argValue = (name: string) => {
  const i = args.indexOf(name);
  return i > -1 ? args[i + 1] : undefined;
};
const WRITE = args.includes("--write");
const OUT = argValue("--out");
const LIMIT = Number(argValue("--limit") || "0") || Infinity;
const CONCURRENCY = Number(process.env.VALOR_PROJETO_CONCURRENCY || "3");

const TOTAL_RE = /total|global|dota[cç][aã]o|or[cç]amento|montante|milh[oõ]|recursos (financeiros )?(dispon|previst|destinad)/i;

const supabase = createSupabase();

async function selectCandidatos(): Promise<string[]> {
  const ids = argValue("--ids");
  if (ids) return ids.split(",").map((s) => s.trim()).filter(Boolean);

  // --so-corretos sozinho = todo o legado publicado.
  const modo = args.includes("--suspeitos")
    ? "suspeitos"
    : args.includes("--legado") || args.includes("--so-corretos")
      ? "legado"
      : null;
  if (!modo) throw new Error("Use --ids, --suspeitos, --legado ou --so-corretos");

  const comPdf = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("edital_pdfs")
      .select("edital_id")
      .eq("is_processed", true)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) if (r.edital_id) comPdf.add(String(r.edital_id));
    if ((data ?? []).length < 1000) break;
  }

  // --so-corretos: só editais já publicados (editais_corretos é o que o site lê).
  let corretos: Set<string> | null = null;
  if (args.includes("--so-corretos")) {
    corretos = new Set();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("editais_corretos").select("id").order("id").range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of data ?? []) corretos.add(String(r.id));
      if ((data ?? []).length < 1000) break;
    }
  }

  const out: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("editais")
      .select("id,valor_projeto")
      .not("valor_projeto", "is", null)
      .order("id")
      .range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      if (!comPdf.has(r.id) || isValorProjetoEstruturado(r.valor_projeto)) continue;
      if (corretos && !corretos.has(r.id)) continue;
      if (modo === "legado" || TOTAL_RE.test(String(r.valor_projeto))) out.push(r.id);
    }
    if ((data ?? []).length < 1000) break;
  }
  return out;
}

type Resultado = {
  id: string;
  fonte: string | null;
  titulo: string;
  status: string;
  antes: string | null;
  depois: string | null;
  erro?: string;
};

async function persist(r: Resultado, evidence: unknown, prevEvidence: unknown) {
  const merged = {
    ...(prevEvidence && typeof prevEvidence === "object" ? (prevEvidence as Record<string, unknown>) : {}),
    valor_projeto: evidence,
  };
  const { error } = await supabase
    .from("editais")
    .update({ valor_projeto: r.depois, informacoes_extracao_evidence: merged })
    .eq("id", r.id);
  if (error) throw new Error(`editais: ${error.message}`);
  // editais_corretos é o que o site lê; atualiza a linha se o edital já foi validado.
  const { error: e2 } = await supabase.from("editais_corretos").update({ valor_projeto: r.depois }).eq("id", r.id);
  if (e2) throw new Error(`editais_corretos: ${e2.message}`);
}

async function main() {
  const ids = (await selectCandidatos()).slice(0, LIMIT);
  console.log(`candidatos: ${ids.length} | modo: ${WRITE ? "GRAVAR" : "dry-run"}`);

  const results: Resultado[] = [];
  let idx = 0;
  async function worker() {
    while (idx < ids.length) {
      const id = ids[idx++]!;
      let r: Resultado;
      try {
        const out = await extractValorProjetoForEdital(id);
        r = {
          id,
          fonte: out.edital.fonte,
          titulo: out.edital.titulo,
          status: out.status,
          antes: out.edital.valor_projeto,
          depois: out.value,
        };
        if (WRITE && out.value) await persist(r, out.evidence, out.edital.informacoes_extracao_evidence);
      } catch (e) {
        r = { id, fonte: null, titulo: "", status: "erro", antes: null, depois: null, erro: String((e as Error).message || e) };
      }
      results.push(r);
      console.log(`\n[${results.length}/${ids.length}] ${r.status} ${r.fonte ?? ""} ${r.id}\n  antes:  ${String(r.antes).slice(0, 220)}\n  depois: ${String(r.depois).slice(0, 400)}${r.erro ? `\n  erro: ${r.erro}` : ""}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const porStatus = results.reduce<Record<string, number>>((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  console.log(`\nresumo: ${JSON.stringify(porStatus)}${WRITE ? ` | gravados: ${results.filter((r) => r.depois).length}` : ""}`);
  if (OUT) {
    writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`resultados salvos em ${OUT}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
