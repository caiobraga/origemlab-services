// Load env from repo/service .env when present.
import "../load-env";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabase } from "../lib/supabase";
import { getMaxContextChars, ollamaEmbed, ollamaGenerate } from "../lib/ollama";

type EditalInfo = {
  id: string;
  numero: string | null;
  titulo: string;
  fonte: string | null;
  informacoes_processadas_em: string | null;
  valor_projeto: string | null;
  prazo_inscricao: string | null;
  localizacao: string | null;
  vagas: string | null;
  is_researcher: boolean | null;
  is_company: boolean | null;
  sobre_programa: string | null;
  criterios_elegibilidade: string | null;
  timeline_estimada: any | null;
};

type FieldKey =
  | "valor_projeto"
  | "prazo_inscricao"
  | "localizacao"
  | "vagas"
  | "is_researcher"
  | "is_company"
  | "sobre_programa"
  | "criterios_elegibilidade"
  | "timeline_estimada";

function fieldType(field: FieldKey): "string" | "boolean" | "json" {
  if (field === "timeline_estimada") return "json";
  if (field === "is_researcher" || field === "is_company") return "boolean";
  return "string";
}

function safeJsonParse(s: string): any | null {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function extractJsonBlock(s: string): string {
  const t = String(s || "").trim();
  if (!t) return "";
  if (t.includes("```")) {
    const m = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (m?.[1]) return m[1].trim();
  }
  return t;
}

function promptForField(field: FieldKey, edital: Pick<EditalInfo, "numero" | "titulo" | "fonte">): string {
  const ex =
    fieldType(field) === "json"
      ? `{\"${field}\":{\"fases\":[{\"nome\":\"Inscrição\",\"prazo\":\"...\",\"status\":\"aberto|fechado|pendente\",\"data_inicio\":\"YYYY-MM-DD\",\"data_fim\":\"YYYY-MM-DD\"}]}} ou {\"${field}\":null}`
      : fieldType(field) === "boolean"
        ? `{\"${field}\": true} ou {\"${field}\": false} ou {\"${field}\": null}`
        : `{\"${field}\":\"texto...\"} ou {\"${field}\": null}`;

  return [
    "Você extrai informações de editais usando SOMENTE o conteúdo abaixo.",
    "Retorne APENAS UM OBJETO JSON VÁLIDO (sem markdown, sem texto extra, sem explicações).",
    "A sua resposta DEVE ser parseável por JSON.parse. Se não for, será descartada.",
    "Se não houver evidência suficiente no conteúdo, use null.",
    "",
    `Edital: ${edital.numero || "N/A"} — ${edital.titulo} (${edital.fonte || "N/A"})`,
    "",
    `Campo: ${field}`,
    `Formato esperado (exemplo): ${ex}`,
    "",
    "REGRAS CRÍTICAS:",
    `- Responda em UMA linha JSON, exatamente com a chave "${field}"`,
    "- Não inclua outras chaves",
    "- Não inclua quebras de linha fora do JSON",
  ].join("\n");
}

async function fetchEditalPdfKeys(supabase: SupabaseClient, editalId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from("edital_pdfs")
    .select("file_id, id")
    .eq("edital_id", editalId);
  if (error) throw new Error(`Erro ao buscar edital_pdfs: ${error.message}`);
  const keys = (data ?? [])
    .map((r: any) => String(r.file_id || r.id || "").trim())
    .filter(Boolean);
  return [...new Set(keys)];
}

async function fetchDocumentsContextByEdital(
  supabase: SupabaseClient,
  editalId: string,
): Promise<{ text: string; sourceLabel: string }> {
  const { data, error } = await supabase
    .from("documents")
    .select("id,file_id,content,metadata,embedding")
    // Prefer metadata.edital_id because some rows may not have documents.file_id populated consistently.
    .eq("metadata->>edital_id", String(editalId))
    .limit(5000);
  if (error) throw new Error(`Erro ao buscar documents: ${error.message}`);

  // Note: top-k selection is applied per-field later; here we just return rows.
  const rows = (data ?? []).filter((r: any) => {
    if (typeof r?.content !== "string" || r.content.trim().length === 0) return false;
    return asEmbedding(r.embedding) != null;
  });

  const joined = rows
    .slice(0, 100)
    .map((r: any) => {
      const fid = String(r.file_id || r.id).slice(0, 12);
      return `--- Documento ${fid} ---\n${String(r.content).trim()}`;
    })
    .join("\n\n");

  const maxChars = getMaxContextChars();
  const text = joined.length > maxChars ? joined.slice(0, maxChars) : joined;
  return { text, sourceLabel: "documents.content (only with embedding) by metadata.edital_id (sample)" };
}

async function fetchDocumentsRows(
  supabase: SupabaseClient,
  { editalId, fileIds }: { editalId: string; fileIds: string[] },
): Promise<any[]> {
  // Prefer edital_id match; fallback to file_id when needed.
  const { data, error } = await supabase
    .from("documents")
    .select("id,file_id,content,metadata,embedding")
    .eq("metadata->>edital_id", String(editalId))
    .limit(8000);
  if (error) throw new Error(`Erro ao buscar documents p/ top-k: ${error.message}`);
  const rows = (data ?? []).filter((r: any) => {
    if (typeof r?.content !== "string" || r.content.trim().length === 0) return false;
    return asEmbedding(r.embedding) != null;
  });
  if (rows.length > 0) return rows;

  if (fileIds.length === 0) return [];
  const { data: data2, error: error2 } = await supabase
    .from("documents")
    .select("id,file_id,content,metadata,embedding")
    .in("file_id", fileIds)
    .limit(8000);
  if (error2) throw new Error(`Erro ao buscar documents (fallback file_id): ${error2.message}`);
  return (data2 ?? []).filter((r: any) => {
    if (typeof r?.content !== "string" || r.content.trim().length === 0) return false;
    return asEmbedding(r.embedding) != null;
  });
}

function topK(defaultK = 40): number {
  const k = parseInt(process.env.PROCESS_EDITAL_TOP_K || process.env.TOP_K || String(defaultK), 10);
  return Number.isFinite(k) ? Math.max(5, Math.min(300, k)) : 40;
}

function fieldTopK(field: FieldKey): number {
  const key = `PROCESS_EDITAL_TOP_K_${field}`.toUpperCase();
  const raw = (process.env as any)[key];
  if (raw != null && String(raw).trim()) {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n)) return Math.max(5, Math.min(300, n));
  }
  // sensible defaults per field
  if (field === "valor_projeto") return topK(25);
  if (field === "prazo_inscricao") return topK(60);
  if (field === "timeline_estimada") return topK(70);
  if (field === "criterios_elegibilidade") return topK(55);
  if (field === "sobre_programa") return topK(45);
  return topK(35);
}

function buildFieldQuery(field: FieldKey, edital: Pick<EditalInfo, "numero" | "titulo" | "fonte">): string {
  const base = `Edital: ${edital.numero || "N/A"} — ${edital.titulo} (${edital.fonte || "N/A"})`;
  const common = "Tarefa: recupere trechos do edital mais relevantes para responder com evidência.";
  const hints: Record<FieldKey, string> = {
    valor_projeto: "Foco: orçamento, recursos, valor máximo/mínimo, teto, dotação, R$, bolsas, financiamento, contrapartida, desembolso.",
    prazo_inscricao: "Foco: prazos e datas de inscrição/submissão, encerramento, cronograma, datas DD/MM/AAAA, YYYY-MM-DD, 'até', 'prazo'.",
    localizacao: "Foco: abrangência, local/estado/município, elegibilidade por território, sede, execução do projeto.",
    vagas: "Foco: número de vagas/bolsas, quantitativo, beneficiários, seleção, cadastro de reserva.",
    is_researcher: "Foco: se pesquisadores/ICT/universidades são elegíveis; requisitos de titulação, vínculo, Lattes.",
    is_company: "Foco: se empresas/CNPJ/startups/MEI são elegíveis; porte, faturamento, CNAE, requisitos.",
    sobre_programa: "Foco: objetivos, público-alvo, escopo, eixos temáticos, modalidades, resumo do edital/programa.",
    criterios_elegibilidade: "Foco: critérios/requisitos, documentação, impedimentos, contrapartidas, habilitação, quem pode/quem não pode.",
    timeline_estimada: "Foco: etapas/fases do processo (inscrição, submissão, análise, homologação, recursos) com prazos/datas.",
  };
  return [base, `Campo: ${field}`, common, hints[field]].join("\n");
}

function asEmbedding(v: any): number[] | null {
  if (!v) return null;
  if (Array.isArray(v) && v.length > 0) return v.map((x) => Number(x));
  // pgvector via PostgREST pode vir como string tipo "[-0.01,0.02,...]"
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const arr = JSON.parse(s);
        if (Array.isArray(arr) && arr.length > 0) return arr.map((x) => Number(x));
      } catch {
        // ignore
      }
    }
  }
  return null;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : -1;
}

function buildTopKContext(
  rows: any[],
  queryEmbedding: number[],
  { label, kOverride }: { label: string; kOverride: number },
): { text: string; sourceLabel: string } {
  const scored = rows
    .map((r) => {
      const emb = asEmbedding(r.embedding);
      if (!emb) return null;
      return { r, score: cosineSimilarity(queryEmbedding, emb) };
    })
    .filter(Boolean) as Array<{ r: any; score: number }>;

  scored.sort((a, b) => b.score - a.score);
  const k = Math.max(5, Math.min(300, kOverride));
  const pick = scored.slice(0, k).map((s) => s.r);

  // Keep deterministic ordering within selected chunks
  pick.sort((a: any, b: any) => {
    const ia = typeof a?.metadata?.chunk_index === "number" ? a.metadata.chunk_index : -1;
    const ib = typeof b?.metadata?.chunk_index === "number" ? b.metadata.chunk_index : -1;
    if (ia !== ib) return ia - ib;
    return String(a.id).localeCompare(String(b.id));
  });

  const joined = pick
    .map((r: any) => {
      const fid = String(r.file_id || r.id).slice(0, 12);
      const ci = typeof r?.metadata?.chunk_index === "number" ? r.metadata.chunk_index : "?";
      return `--- Documento ${fid} / chunk ${ci} ---\n${String(r.content).trim()}`;
    })
    .join("\n\n");

  const maxChars = getMaxContextChars();
  const text = joined.length > maxChars ? joined.slice(0, maxChars) : joined;
  return { text, sourceLabel: `top-k=${Math.min(k, pick.length)} via cosine (${label})` };
}

async function generateStrictJson(
  field: FieldKey,
  edital: EditalInfo,
  context: string,
): Promise<{ value: any; rawJson: string; modelOutput: string }> {
  const prompt = [
    promptForField(field, edital),
    "",
    "CONTEÚDO:",
    context || "(vazio)",
  ].join("\n");

  const llmOut = await ollamaGenerate(prompt);
  const raw = extractJsonBlock(llmOut);
  const json = safeJsonParse(raw);
  const value = json && typeof json === "object" ? (json as any)[field] : undefined;
  return { value: value === undefined ? null : value, rawJson: raw, modelOutput: llmOut };
}

async function extractFieldValue(
  field: FieldKey,
  edital: EditalInfo,
  context: string,
): Promise<{ value: any; rawJson: string; modelOutput: string }> {
  // retry once if JSON is invalid / missing key
  let attempt = 0;
  let last: { value: any; rawJson: string; modelOutput: string } | null = null;
  while (attempt < 2) {
    const out = await generateStrictJson(field, edital, context);
    last = out;
    const parsed = safeJsonParse(out.rawJson);
    const hasKey = parsed && typeof parsed === "object" && (parsed as any)[field] !== undefined;
    if (hasKey) {
      const value = (parsed as any)[field];
      last = { ...out, value };
      break;
    }
    // second attempt: explicitly ask to fix formatting
    if (attempt === 0) {
      const fixPrompt = [
        "Sua resposta anterior NÃO estava em JSON válido, ou não tinha a chave correta.",
        `Corrija e responda SOMENTE com 1 JSON válido com a chave "${field}".`,
        "Não inclua nenhuma outra coisa.",
        "",
        "RESPOSTA ANTERIOR (para corrigir):",
        String(out.modelOutput || "").slice(0, 2000),
        "",
        "CONTEÚDO (mesmo conteúdo):",
        context || "(vazio)",
      ].join("\n");
      const llmOut2 = await ollamaGenerate(fixPrompt);
      const raw2 = extractJsonBlock(llmOut2);
      const parsed2 = safeJsonParse(raw2);
      const v2 = parsed2 && typeof parsed2 === "object" ? (parsed2 as any)[field] : undefined;
      if (v2 !== undefined) {
        last = { value: v2, rawJson: raw2, modelOutput: llmOut2 };
        break;
      }
      last = { value: null, rawJson: raw2, modelOutput: llmOut2 };
    }
    attempt++;
  }

  const value = last?.value;
  const rawJson = last?.rawJson || "";
  const modelOutput = last?.modelOutput || "";
  if (value === undefined) return { value: null, rawJson, modelOutput };

  const t = fieldType(field);
  if (value === null) return { value: null, rawJson, modelOutput };
  if (t === "boolean") return { value: typeof value === "boolean" ? value : null, rawJson, modelOutput };
  if (t === "json") return { value: typeof value === "object" ? value : null, rawJson, modelOutput };
  return { value: typeof value === "string" ? value.trim() : null, rawJson, modelOutput };
}

function previewContext(ctx: string, maxChars = 900): string {
  const t = String(ctx || "").trim();
  if (!t) return "(vazio)";
  if (t.length <= maxChars) return t;
  return `${t.slice(0, maxChars)}\n... [truncado ${t.length - maxChars} chars]`;
}

function hasNonEmptyContextText(s: string): boolean {
  return Boolean(String(s || "").trim());
}

async function updateEditalInfo(supabase: SupabaseClient, editalId: string, patch: Record<string, any>) {
  const updateData = { ...patch, informacoes_processadas_em: new Date().toISOString() };
  const { error } = await supabase.from("editais").update(updateData).eq("id", editalId);
  if (error) throw new Error(`Erro ao atualizar edital: ${error.message}`);
}

async function fetchEditaisWithNullFields(supabase: SupabaseClient): Promise<EditalInfo[]> {
  const { data, error } = await supabase
    .from("editais")
    .select(
      "id,numero,titulo,fonte,informacoes_processadas_em,valor_projeto,prazo_inscricao,localizacao,vagas,is_researcher,is_company,sobre_programa,criterios_elegibilidade,timeline_estimada",
    )
    .or(
      "valor_projeto.is.null,prazo_inscricao.is.null,localizacao.is.null,vagas.is.null,sobre_programa.is.null,criterios_elegibilidade.is.null,timeline_estimada.is.null,is_researcher.is.null,is_company.is.null",
    )
    .order("criado_em", { ascending: false });
  if (error) throw new Error(`Erro ao buscar editais: ${error.message}`);
  return (data ?? []) as EditalInfo[];
}

async function main() {
  const supabase = createSupabase();

  const limitRaw = parseInt(process.env.PROCESS_EDITAL_LIMIT || "0", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity;
  const delayBetweenEditaisMs = Math.max(0, parseInt(process.env.DELAY_BETWEEN_EDITAIS_MS || "2000", 10) || 2000);

  console.log("🧠 process-edital-service (Ollama-only)");
  console.log(`📦 limit=${Number.isFinite(limit) ? limit : "∞"} delayBetweenEditaisMs=${delayBetweenEditaisMs}`);

  const editais = await fetchEditaisWithNullFields(supabase);
  const targets = Number.isFinite(limit) ? editais.slice(0, limit) : editais;
  console.log(`📥 editais a processar: ${targets.length}`);

  const fields: FieldKey[] = [
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

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < targets.length; i++) {
    const edital = targets[i]!;
    console.log(`\n🧾 ${edital.numero || "N/A"} — ${edital.titulo} (${edital.fonte || "N/A"})`);
    console.log(`  🆔 edital_id=${edital.id}`);
    try {
      const fileIds = await fetchEditalPdfKeys(supabase, edital.id);
      const ctxAll = await fetchDocumentsContextByEdital(supabase, edital.id);
      console.log(`  📎 file_ids=${fileIds.length} ctx=${ctxAll.text.length} source=${ctxAll.sourceLabel}`);

      // Fetch full rows (content+embedding) for top-k selection.
      const rows = await fetchDocumentsRows(supabase, { editalId: edital.id, fileIds });
      const embCount = rows.filter((r: any) => asEmbedding(r.embedding) != null).length;
      console.log(`  🔎 chunks=${rows.length} com_embedding=${embCount} top_k=${topK()}`);

      // Skip editais without any usable context (prevents LLM calls with "(vazio)").
      const hasAnyChunkText = rows.some((r: any) => typeof r?.content === "string" && r.content.trim().length > 0);
      const hasContextSample = hasNonEmptyContextText(ctxAll.text);
      if (!hasAnyChunkText && !hasContextSample) {
        console.log("  ⏭️ pulando: sem chunks/contexto em `documents` para este edital.");
        continue;
      }

      const patch: Record<string, any> = {};
      for (const f of fields) {
        const before = (edital as any)[f];
        if (before != null) continue; // mimic "only null fields"

        let ctxText = ctxAll.text;
        let ctxSource = ctxAll.sourceLabel;
        if (embCount > 0) {
          const query = buildFieldQuery(f, edital);
          const qEmb = await ollamaEmbed(query);
          const top = buildTopKContext(rows, qEmb, { label: f, kOverride: fieldTopK(f) });
          ctxText = top.text || ctxText;
          ctxSource = top.sourceLabel;
        }

        if (!hasNonEmptyContextText(ctxText)) {
          console.log(`\n  🧠 campo=${f} ctx_source=${ctxSource} ctx_len=0`);
          console.log("  ⏭️ pulando campo: contexto vazio.");
          continue;
        }

        console.log(`\n  🧠 campo=${f} ctx_source=${ctxSource} ctx_len=${ctxText.length}`);
        console.log(`  🧩 contexto_enviado (preview):\n${previewContext(ctxText)}`);

        const { value, rawJson, modelOutput } = await extractFieldValue(f, edital, ctxText);
        patch[f] = value;

        console.log(`  🧾 resposta_modelo (raw preview):\n${previewContext(modelOutput, 900)}`);
        console.log(`  🧾 json_extraido:\n${rawJson || "(vazio)"}`);
        console.log(
          `  ✅ resultado_${f}: ${value === null ? "null" : typeof value === "string" ? value.slice(0, 180) : JSON.stringify(value).slice(0, 400)}`,
        );
      }

      if (Object.keys(patch).length === 0) {
        console.log("  ⏭️ pulando update: nenhum campo processável (todos sem contexto ou já preenchidos).");
        continue;
      }

      await updateEditalInfo(supabase, edital.id, patch);
      ok++;
      console.log("  ✅ atualizado");
    } catch (e) {
      fail++;
      console.error("  ❌ erro:", e instanceof Error ? e.message : String(e));
    }
    if (i < targets.length - 1 && delayBetweenEditaisMs > 0) {
      await new Promise((r) => setTimeout(r, delayBetweenEditaisMs));
    }
  }

  console.log(`\n✅ done ok=${ok} fail=${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("❌ fatal:", e);
  process.exitCode = 1;
});

