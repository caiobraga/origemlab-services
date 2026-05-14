// Load env from repo/service .env when present.
import "../load-env";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabase } from "../lib/supabase";
import { getMaxContextChars, ollamaEmbed, ollamaGenerate } from "../lib/ollama";

type FieldEvidence = {
  /** `topk` = contexto por similaridade de embeddings; `bulk` = amostra/junção de chunks sem score; `window` = varredura por janelas sobre o texto plano. */
  source: "topk" | "window" | "bulk";
  snippet: string;
  /** IDs das linhas em `documents` cujo texto entrou no contexto / janela usada na extração. */
  document_ids?: string[];
  /** Primeiro id de `document_ids` (atalho para consumidores que esperam um único documento). */
  document_id?: string | null;
  chunk_index?: number | null;
  window_index?: number | null;
};

type EditalInfo = {
  id: string;
  numero: string | null;
  titulo: string;
  fonte: string | null;
  criado_em: string | null;
  informacoes_processadas_em: string | null;
  informacoes_extracao_evidence?: Record<string, FieldEvidence> | null;
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

/** Indica se o campo ainda deve passar pela extração (null, vazio, timeline vazia, boolean ausente). */
function fieldNeedsExtraction(field: FieldKey, before: any): boolean {
  if (field === "timeline_estimada") {
    return !extractionValueIsUseful(field, before);
  }
  if (field === "is_researcher" || field === "is_company") {
    return typeof before !== "boolean";
  }
  if (fieldType(field) === "string") {
    if (before === null || before === undefined) return true;
    if (typeof before === "string") return before.trim() === "";
    return true;
  }
  return before === null || before === undefined;
}

function editalNeedsAnyFieldExtraction(edital: EditalInfo, fields: FieldKey[]): boolean {
  return fields.some((f) => fieldNeedsExtraction(f, (edital as any)[f]));
}

type ChunkOrderRow = { edital_id: string; chunks: number };

/** RPC alinhada a `sql/20260513_process_edital_editais_com_document_chunks.sql`. */
async function fetchEditaisDocumentChunkOrder(supabase: SupabaseClient): Promise<ChunkOrderRow[] | null> {
  if (String(process.env.PROCESS_EDITAL_SKIP_CHUNK_ORDER_RPC || "").trim() === "1") {
    console.log("ℹ️ PROCESS_EDITAL_SKIP_CHUNK_ORDER_RPC=1 — RPC de ordem por chunks desligada.");
    return null;
  }
  const { data, error } = await supabase.rpc("process_edital_editais_com_document_chunks");
  if (error) {
    console.warn(
      `⚠️ RPC process_edital_editais_com_document_chunks: ${error.message} — aplicar sql/20260513_process_edital_editais_com_document_chunks.sql ou definir PROCESS_EDITAL_SKIP_CHUNK_ORDER_RPC=1.`,
    );
    return null;
  }
  const rows = (data ?? []) as any[];
  return rows
    .map((r) => ({
      edital_id: String(r.edital_id ?? "").trim(),
      chunks: Number(r.chunks ?? 0) || 0,
    }))
    .filter((r) => r.edital_id);
}

function chunkOrderRankMap(rows: ChunkOrderRow[]): Map<string, number> {
  const m = new Map<string, number>();
  rows.forEach((r, i) => m.set(r.edital_id, i));
  return m;
}

/** Editais sem linha na RPC vão depois de todos os que têm chunks (rank “infinito”). */
const CHUNK_ORDER_RANK_MISS = 1e12;

/**
 * `pending_first` (default): ordem da RPC (mais chunks primeiro), depois campos pendentes, depois `criado_em` desc.
 * `documents_chunks_only`: só RPC + `criado_em` para empates / editais fora da RPC.
 * `criado_em_desc` | `fetch`: mantém ordem da query em `fetchEditaisAllForProcessing`.
 */
function applyProcessEditalOrdering(
  editais: EditalInfo[],
  fields: FieldKey[],
  chunkRank: Map<string, number> | null,
): void {
  const mode = String(process.env.PROCESS_EDITAL_ORDER || "pending_first").trim().toLowerCase();
  if (mode === "criado_em_desc" || mode === "fetch") return;
  if (mode === "documents_chunks_only") {
    if (!chunkRank?.size) return;
    editais.sort((a, b) => {
      const ra = chunkRank.has(a.id) ? chunkRank.get(a.id)! : CHUNK_ORDER_RANK_MISS;
      const rb = chunkRank.has(b.id) ? chunkRank.get(b.id)! : CHUNK_ORDER_RANK_MISS;
      if (ra !== rb) return ra - rb;
      const ta = Date.parse(String(a.criado_em || "")) || 0;
      const tb = Date.parse(String(b.criado_em || "")) || 0;
      return tb - ta;
    });
    return;
  }
  editais.sort((a, b) => {
    const ra = chunkRank?.has(a.id) ? chunkRank.get(a.id)! : CHUNK_ORDER_RANK_MISS;
    const rb = chunkRank?.has(b.id) ? chunkRank.get(b.id)! : CHUNK_ORDER_RANK_MISS;
    if (ra !== rb) return ra - rb;
    const pa = editalNeedsAnyFieldExtraction(a, fields) ? 0 : 1;
    const pb = editalNeedsAnyFieldExtraction(b, fields) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    const ta = Date.parse(String(a.criado_em || "")) || 0;
    const tb = Date.parse(String(b.criado_em || "")) || 0;
    return tb - ta;
  });
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

/** IDs de `documents` cujos blocos (join com `\n\n`) intersectam o prefixo [0, joinedLen). */
function documentIdsFromPiecesIncluded(pieces: string[], usedRows: any[], joinedLen: number): string[] {
  const ids: string[] = [];
  let pos = 0;
  for (let i = 0; i < pieces.length && pos < joinedLen; i++) {
    if (i > 0) pos += 2;
    if (pos >= joinedLen) break;
    const id = usedRows[i]?.id;
    if (id != null && String(id).trim()) ids.push(String(id));
    pos += pieces[i]!.length;
  }
  return [...new Set(ids)];
}

function docIdsEvidenceFields(ids: string[]): Pick<FieldEvidence, "document_id" | "document_ids"> {
  const clean = [...new Set(ids.map((x) => String(x).trim()).filter(Boolean))];
  if (!clean.length) return { document_id: null, document_ids: undefined };
  return { document_id: clean[0]!, document_ids: clean };
}

function dedupeDocumentsById(rows: any[]): any[] {
  const m = new Map<string, any>();
  for (const r of rows ?? []) {
    if (r?.id != null) m.set(String(r.id), r);
  }
  return [...m.values()];
}

/** Chunk pertence ao edital: `metadata.edital_id` ou `file_id` (coluna ou metadata). */
function rowBelongsToEdital(r: any, editalId: string, fileIdSet: Set<string>): boolean {
  const eid = String(editalId).trim();
  const mid = r?.metadata != null ? (r.metadata.edital_id ?? r.metadata.editalId) : undefined;
  if (mid != null && String(mid).trim() === eid) return true;
  const fid = r?.file_id != null ? String(r.file_id).trim() : "";
  if (fid && fileIdSet.has(fid)) return true;
  const mf = r?.metadata?.file_id != null ? String(r.metadata.file_id).trim() : "";
  if (mf && fileIdSet.has(mf)) return true;
  return false;
}

const DOCUMENTS_SELECT_COLUMNS = "id,file_id,content,metadata,embedding,embedding_perguntas";

/**
 * Busca chunks do edital: `metadata.edital_id` OU `file_id` ∈ edital_pdfs.
 * PostgREST devolve `embedding` como array JSON; às vezes aninhado `[[...]]` (batch) — ver `asEmbedding`.
 */
async function fetchDocumentsForEdital(
  supabase: SupabaseClient,
  editalId: string,
  fileIds: string[],
  limit: number,
): Promise<any[]> {
  const eid = String(editalId).trim();
  const cleanFids = [...new Set(fileIds.map((x) => String(x).trim()).filter(Boolean))];
  const fidSet = new Set(cleanFids);

  let data: any[] | null = null;
  let error: any = null;

  if (cleanFids.length > 0) {
    const orFilter = `metadata->>edital_id.eq.${eid},file_id.in.(${cleanFids.join(",")})`;
    const res = await supabase.from("documents").select(DOCUMENTS_SELECT_COLUMNS).or(orFilter).limit(limit);
    data = res.data;
    error = res.error;
  } else {
    const res = await supabase
      .from("documents")
      .select(DOCUMENTS_SELECT_COLUMNS)
      .eq("metadata->>edital_id", eid)
      .limit(limit);
    data = res.data;
    error = res.error;
  }

  if (error) throw new Error(`Erro ao buscar documents: ${error.message}`);
  const merged = dedupeDocumentsById(data ?? []);
  return merged.filter((r) => rowBelongsToEdital(r, eid, fidSet));
}

async function fetchDocumentsContextByEdital(
  supabase: SupabaseClient,
  editalId: string,
  fileIds: string[],
): Promise<{ text: string; sourceLabel: string; documentIds: string[] }> {
  const raw = await fetchDocumentsForEdital(supabase, editalId, fileIds, 5000);
  const rows = raw.filter((r: any) => {
    if (typeof r?.content !== "string" || r.content.trim().length === 0) return false;
    return rowHasAnyEmbeddingForTopK(r);
  });

  const sliceRows = rows.slice(0, 100);
  const pieces = sliceRows.map((r: any) => {
    const fid = String(r.file_id || r.metadata?.file_id || r.id).slice(0, 12);
    return `--- Documento ${fid} ---\n${String(r.content).trim()}`;
  });
  const joined = pieces.join("\n\n");

  const maxChars = getMaxContextChars();
  const text = joined.length > maxChars ? joined.slice(0, maxChars) : joined;
  const documentIds = documentIdsFromPiecesIncluded(pieces, sliceRows, text.length);
  return {
    text,
    sourceLabel: "documents.content (chunks com embedding ou embedding_perguntas; metadata.edital_id ou file_id edital_pdfs)",
    documentIds,
  };
}

async function fetchDocumentsRows(
  supabase: SupabaseClient,
  { editalId, fileIds }: { editalId: string; fileIds: string[] },
): Promise<any[]> {
  const raw = await fetchDocumentsForEdital(supabase, editalId, fileIds, 8000);
  return raw.filter((r: any) => {
    if (typeof r?.content !== "string" || r.content.trim().length === 0) return false;
    return rowHasAnyEmbeddingForTopK(r);
  });
}

/** Chunks com texto (com ou sem embedding) — usado na varredura por janelas. */
async function fetchDocumentsRowsAllWithContent(
  supabase: SupabaseClient,
  { editalId, fileIds }: { editalId: string; fileIds: string[] },
): Promise<any[]> {
  const raw = await fetchDocumentsForEdital(supabase, editalId, fileIds, 8000);
  return raw.filter((r: any) => typeof r?.content === "string" && r.content.trim().length > 0);
}

function sortRowsByChunkIndex(rows: any[]): any[] {
  return [...rows].sort((a: any, b: any) => {
    const ia = typeof a?.metadata?.chunk_index === "number" ? a.metadata.chunk_index : -1;
    const ib = typeof b?.metadata?.chunk_index === "number" ? b.metadata.chunk_index : -1;
    if (ia !== ib) return ia - ib;
    return String(a.id).localeCompare(String(b.id));
  });
}

/** Texto plano (só `content`) na ordem de leitura + mapa de intervalos → `documents.id`. */
function buildPlainWithSpans(rows: any[]): { plain: string; spans: Array<{ from: number; to: number; id: string }> } {
  const sorted = sortRowsByChunkIndex(rows);
  const spans: Array<{ from: number; to: number; id: string }> = [];
  const texts: string[] = [];
  let at = 0;
  for (const r of sorted) {
    const t = String(r.content || "").trim();
    if (!t) continue;
    if (texts.length > 0) at += 2;
    const from = at;
    at += t.length;
    spans.push({ from, to: at, id: String(r.id) });
    texts.push(t);
  }
  return { plain: texts.join("\n\n"), spans };
}

function documentIdsOverlappingPlainRange(
  spans: Array<{ from: number; to: number; id: string }>,
  start: number,
  end: number,
): string[] {
  const u = new Set<string>();
  for (const sp of spans) {
    if (sp.to > start && sp.from < end) u.add(sp.id);
  }
  return [...u];
}

function buildPlainFullText(rows: any[]): string {
  return buildPlainWithSpans(rows).plain;
}

function extractionValueIsUseful(field: FieldKey, value: any): boolean {
  if (value === undefined) return false;
  if (field === "timeline_estimada") {
    if (value === null) return false;
    const v = typeof value === "object" && value && "fases" in value ? value : null;
    if (!v || !Array.isArray((v as any).fases)) return false;
    return (v as any).fases.length > 0;
  }
  if (field === "is_researcher" || field === "is_company") return typeof value === "boolean";
  if (value === null) return false;
  if (typeof value === "string") return Boolean(String(value).trim());
  return false;
}

function snippetFromContext(ctx: string): string {
  const max = Math.max(400, parseInt(process.env.PROCESS_EDITAL_EVIDENCE_SNIPPET_MAX || "2800", 10) || 2800);
  const t = String(ctx || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}

async function tryWindowScan(
  field: FieldKey,
  edital: EditalInfo,
  rowsAll: any[],
): Promise<{ value: any; rawJson: string; modelOutput: string; evidence: FieldEvidence | null }> {
  const { plain, spans } = buildPlainWithSpans(rowsAll);
  if (!plain.trim()) {
    return { value: null, rawJson: "", modelOutput: "", evidence: null };
  }

  const windowSize = Math.max(2000, parseInt(process.env.PROCESS_EDITAL_WINDOW_CHARS || "12000", 10) || 12000);
  const overlap = Math.max(0, parseInt(process.env.PROCESS_EDITAL_WINDOW_OVERLAP || "2000", 10) || 2000);
  const maxW = Math.max(1, parseInt(process.env.PROCESS_EDITAL_WINDOW_MAX_WINDOWS || "80", 10) || 80);
  const maxCtx = getMaxContextChars();

  let start = 0;
  let wi = 0;
  let lastOut: { value: any; rawJson: string; modelOutput: string } = { value: null, rawJson: "", modelOutput: "" };

  while (start < plain.length && wi < maxW) {
    const end = Math.min(plain.length, start + Math.min(windowSize, maxCtx));
    const slice = plain.slice(start, end);
    wi += 1;

    // Janela só com espaços: avança. (Antes: `slice.trim().length < 40` fazia **break** e abortava TODA a varredura.)
    if (!slice.trim()) {
      if (end >= plain.length) break;
      const nextStart = end - overlap;
      start = nextStart <= start ? start + 1 : nextStart;
      continue;
    }

    const ex = await extractFieldValue(field, edital, slice);
    lastOut = ex;
    if (extractionValueIsUseful(field, ex.value)) {
      const docIds = documentIdsOverlappingPlainRange(spans, start, end);
      return {
        value: ex.value,
        rawJson: ex.rawJson,
        modelOutput: ex.modelOutput,
        evidence: {
          source: "window",
          snippet: snippetFromContext(slice),
          window_index: wi - 1,
          ...docIdsEvidenceFields(docIds),
        },
      };
    }

    if (end >= plain.length) break;
    const nextStart = end - overlap;
    start = nextStart <= start ? start + 1 : nextStart;
  }

  return { value: null, rawJson: lastOut.rawJson, modelOutput: lastOut.modelOutput, evidence: null };
}

async function extractFieldWithTopKThenWindows(
  field: FieldKey,
  edital: EditalInfo,
  rowsEmb: any[],
  rowsAll: any[],
  embCount: number,
  ctxAll: { text: string; sourceLabel: string; documentIds: string[] },
): Promise<{ value: any; rawJson: string; modelOutput: string; evidence: FieldEvidence | null }> {
  let lastEx: { value: any; rawJson: string; modelOutput: string } = { value: null, rawJson: "", modelOutput: "" };

  /** Houve contexto top-k não vazio (embeddings + chunks) — se a extração vier null/inútil, o próximo passo são só as janelas, sem “bulk” no meio. */
  let topkContextAttempted = false;

  // 1) Top-k (similaridade) quando há embeddings
  if (embCount > 0) {
    const query = buildFieldQuery(field, edital);
    const qEmb = await ollamaEmbed(query);
    const top = buildTopKContext(rowsEmb, qEmb, { label: field, kOverride: fieldTopK(field) });
    if (hasNonEmptyContextText(top.text)) {
      topkContextAttempted = true;
      const ex = await extractFieldValue(field, edital, top.text);
      lastEx = ex;
      if (extractionValueIsUseful(field, ex.value)) {
        return {
          value: ex.value,
          rawJson: ex.rawJson,
          modelOutput: ex.modelOutput,
          evidence: {
            source: "topk",
            snippet: snippetFromContext(top.text),
            ...docIdsEvidenceFields(top.documentIds),
          },
        };
      }
    }
  }

  // 2) Amostra “bulk” só quando não houve tentativa top-k com texto (ex.: sem embeddings ou top vazio)
  if (!topkContextAttempted && hasNonEmptyContextText(ctxAll.text)) {
    const ex = await extractFieldValue(field, edital, ctxAll.text);
    lastEx = ex;
    if (extractionValueIsUseful(field, ex.value)) {
      return {
        value: ex.value,
        rawJson: ex.rawJson,
        modelOutput: ex.modelOutput,
        evidence: {
          source: "bulk",
          snippet: snippetFromContext(ctxAll.text),
          ...docIdsEvidenceFields(ctxAll.documentIds),
        },
      };
    }
  }

  // 3) Janelas deslizantes sobre o texto plano de todos os chunks (após top-k inútil/null ou bulk inútil)
  const plainChars = buildPlainFullText(rowsAll).length;
  console.log(
    `  🪟 campo=${field}: janelas | plain_chars=${plainChars} chunks=${rowsAll.length} topk_ctx_tentado=${topkContextAttempted}`,
  );
  const win = await tryWindowScan(field, edital, rowsAll);
  if (extractionValueIsUseful(field, win.value)) return win;

  return {
    value: extractionValueIsUseful(field, lastEx.value) ? lastEx.value : null,
    rawJson: win.rawJson || lastEx.rawJson,
    modelOutput: win.modelOutput || lastEx.modelOutput,
    evidence: null,
  };
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

/** Mesmo prefixo que `document-processor` grava em `embeddingText` (enrichChunk.mjs) — alinha query↔chunk no espaço de embeddings. */
const RETRIEVAL_QUERY_PREFIX = "[CONTEXTO PARA BUSCA — alinhado ao pipeline process-edital-info]";

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
  const hint = hints[field];
  return [
    RETRIEVAL_QUERY_PREFIX,
    `Campos relacionados: ${field}`,
    `Perguntas exemplo: Que informações do edital respondem a este campo? ${hint}`,
    "",
    base,
    `Campo: ${field}`,
    common,
    hint,
  ].join("\n");
}

function asEmbedding(v: any): number[] | null {
  if (v == null || v === "") return null;

  let cur: any = v;

  if (typeof cur === "string") {
    const s = cur.trim();
    if (!s) return null;
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        cur = JSON.parse(s);
      } catch {
        return null;
      }
    } else {
      return null;
    }
  }

  // Ollama / JSON: vetor às vezes vem embrulhado uma ou mais vezes, ex. [[0.1, 0.2, ...]]
  while (Array.isArray(cur) && cur.length === 1 && Array.isArray(cur[0])) {
    cur = cur[0];
  }

  if (!Array.isArray(cur) || cur.length === 0) return null;

  const nums = cur.map((x) => Number(x));
  if (nums.length < 4) return null;
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

/** Chunk com vetor para top-k: coluna `embedding_perguntas` (só cabeçalho/perguntas) ou legado `embedding`. */
function rowHasAnyEmbeddingForTopK(r: any): boolean {
  return asEmbedding(r.embedding_perguntas) != null || asEmbedding(r.embedding) != null;
}

/** Vetor usado no cosseno do top-k: default `embedding_perguntas` se existir; senão `embedding`. `PROCESS_EDITAL_TOPK_EMBEDDING=full` força só `embedding`. */
function embeddingVectorForTopKCompare(r: any): number[] | null {
  const mode = String(process.env.PROCESS_EDITAL_TOPK_EMBEDDING || "perguntas").trim().toLowerCase();
  if (mode === "full") return asEmbedding(r.embedding);
  const p = asEmbedding(r.embedding_perguntas);
  if (p) return p;
  return asEmbedding(r.embedding);
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

function formatChunkBlock(r: any): string {
  const fid = String(r.file_id || r.metadata?.file_id || r.id).slice(0, 12);
  const ci = typeof r?.metadata?.chunk_index === "number" ? r.metadata.chunk_index : "?";
  return `--- Documento ${fid} / chunk ${ci} ---\n${String(r.content).trim()}`;
}

/**
 * Monta contexto a partir dos top-k por cosseno.
 * - `score` (default): empacota trechos em ordem de relevância até OLLAMA_MAX_CONTEXT_CHARS, para não perder o chunk mais forte ao truncar do início do PDF.
 * - `reading`: ordena por chunk_index e trunca no final (legado).
 */
function buildTopKContext(
  rows: any[],
  queryEmbedding: number[],
  { label, kOverride }: { label: string; kOverride: number },
): { text: string; sourceLabel: string; documentIds: string[] } {
  const scored = rows
    .map((r) => {
      const emb = embeddingVectorForTopKCompare(r);
      if (!emb) return null;
      return { r, score: cosineSimilarity(queryEmbedding, emb) };
    })
    .filter(Boolean) as Array<{ r: any; score: number }>;

  scored.sort((a, b) => b.score - a.score);
  const k = Math.max(5, Math.min(300, kOverride));
  const top = scored.slice(0, k);

  const maxChars = getMaxContextChars();
  const packOrder = String(process.env.PROCESS_EDITAL_CONTEXT_PACK_ORDER || "score").toLowerCase();
  const useReadingOrder = packOrder === "reading";

  let pieces: string[];
  let usedRows: any[];
  if (useReadingOrder) {
    const pick = top.map((s) => s.r);
    pick.sort((a: any, b: any) => {
      const ia = typeof a?.metadata?.chunk_index === "number" ? a.metadata.chunk_index : -1;
      const ib = typeof b?.metadata?.chunk_index === "number" ? b.metadata.chunk_index : -1;
      if (ia !== ib) return ia - ib;
      return String(a.id).localeCompare(String(b.id));
    });
    usedRows = pick;
    pieces = pick.map((r: any) => formatChunkBlock(r));
  } else {
    usedRows = top.map((s) => s.r);
    pieces = top.map((s) => formatChunkBlock(s.r));
  }

  let joined = pieces.join("\n\n");
  if (joined.length > maxChars) {
    if (useReadingOrder) {
      joined = joined.slice(0, maxChars);
    } else {
      joined = "";
      const keptPieces: string[] = [];
      const keptRows: any[] = [];
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i]!;
        const r = usedRows[i]!;
        const next = joined ? `${joined}\n\n${p}` : p;
        if (next.length <= maxChars) {
          joined = next;
          keptPieces.push(p);
          keptRows.push(r);
        } else {
          if (!joined) {
            joined = p.slice(0, maxChars);
            keptPieces.push(joined);
            keptRows.push(r);
          }
          break;
        }
      }
      return {
        text: joined,
        sourceLabel: `top-k=${Math.min(k, top.length)} cosine (${label}) pack=score`,
        documentIds: documentIdsFromPiecesIncluded(keptPieces.length ? keptPieces : [joined], keptRows.length ? keptRows : usedRows.slice(0, 1), joined.length),
      };
    }
  }

  const orderNote = useReadingOrder ? "pack=reading-truncate" : "pack=score";
  const documentIds = documentIdsFromPiecesIncluded(pieces, usedRows, joined.length);
  return {
    text: joined,
    sourceLabel: `top-k=${Math.min(k, top.length)} cosine (${label}) ${orderNote}`,
    documentIds,
  };
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

const EDITAIS_PROCESS_SELECT =
  "id,numero,titulo,fonte,criado_em,informacoes_processadas_em,informacoes_extracao_evidence,valor_projeto,prazo_inscricao,localizacao,vagas,is_researcher,is_company,sobre_programa,criterios_elegibilidade,timeline_estimada";

/** Carrega todos os editais (paginado). A decisão de chamar o modelo é por campo em `fieldNeedsExtraction`. */
async function fetchEditaisAllForProcessing(supabase: SupabaseClient): Promise<EditalInfo[]> {
  const pageRaw = parseInt(process.env.PROCESS_EDITAL_FETCH_PAGE_SIZE || "1000", 10);
  const pageSize = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.min(5000, Math.max(50, pageRaw)) : 1000;
  const out: EditalInfo[] = [];
  let from = 0;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await supabase
      .from("editais")
      .select(EDITAIS_PROCESS_SELECT)
      .order("criado_em", { ascending: false })
      .range(from, to);
    if (error) throw new Error(`Erro ao buscar editais: ${error.message}`);
    const batch = (data ?? []) as EditalInfo[];
    out.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

function ecsWorkerLoopEnabled(): boolean {
  const v = String(process.env.ECS_WORKER_LOOP || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function workerIdleMsAfterWork(): number {
  const n = parseInt(process.env.WORKER_IDLE_MS_AFTER_WORK || "8000", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 8000;
}

function workerIdleMsNoWork(): number {
  const n = parseInt(process.env.WORKER_IDLE_MS_NO_WORK || "120000", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 120000;
}

async function runProcessBatch(): Promise<{ hadWork: boolean }> {
  const supabase = createSupabase();

  const limitRaw = parseInt(process.env.PROCESS_EDITAL_LIMIT || "0", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity;
  const delayBetweenEditaisMs = Math.max(0, parseInt(process.env.DELAY_BETWEEN_EDITAIS_MS || "2000", 10) || 2000);
  const onlyId = String(process.env.PROCESS_EDITAL_ONLY_ID || "").trim();

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

  console.log("🧠 process-edital-service (Ollama-only)");
  console.log(
    `📦 limit=${Number.isFinite(limit) ? limit : "∞"} delayBetweenEditaisMs=${delayBetweenEditaisMs} order=${String(process.env.PROCESS_EDITAL_ORDER || "pending_first").trim() || "pending_first"}`,
  );
  if (onlyId) console.log(`🎯 PROCESS_EDITAL_ONLY_ID=${onlyId}`);

  let editais = await fetchEditaisAllForProcessing(supabase);
  const loadedFromDb = editais.length;
  const chunkRows = await fetchEditaisDocumentChunkOrder(supabase);
  const chunkRank = chunkRows && chunkRows.length > 0 ? chunkOrderRankMap(chunkRows) : null;
  if (chunkRows?.length) {
    console.log(`📊 RPC chunks: ${chunkRows.length} editais com documents (content não vazio), ordem decrescente de volume`);
  }
  if (onlyId) {
    editais = editais.filter((e) => e.id === onlyId);
    console.log(`🎯 filtro only_id → ${editais.length} edital(is) na lista`);
    if (editais.length === 0) {
      console.warn("⚠️ Nenhum edital com esse id na tabela `editais` (verifique o UUID).");
    }
  }
  applyProcessEditalOrdering(editais, fields, chunkRank);
  const targets = Number.isFinite(limit) ? editais.slice(0, limit) : editais;
  console.log(
    `📥 editais carregados=${loadedFromDb}${onlyId ? ` (após only_id: ${editais.length})` : ""} a processar neste lote=${targets.length}`,
  );

  let ok = 0;
  let fail = 0;
  let skipCompleto = 0;
  let skipSemDocumentos = 0;
  let skipSemUpdateDb = 0;

  for (let i = 0; i < targets.length; i++) {
    const edital = targets[i]!;
    console.log(`\n🧾 ${edital.numero || "N/A"} — ${edital.titulo} (${edital.fonte || "N/A"})`);
    console.log(`  🆔 edital_id=${edital.id}`);
    try {
      if (!editalNeedsAnyFieldExtraction(edital, fields)) {
        if (!(edital as any).informacoes_processadas_em) {
          const { error: stampErr } = await supabase
            .from("editais")
            .update({ informacoes_processadas_em: new Date().toISOString() })
            .eq("id", edital.id);
          if (stampErr) throw new Error(`Erro ao marcar informacoes_processadas_em: ${stampErr.message}`);
          console.log("  ℹ️ Campos extraíveis já preenchidos — gravando informacoes_processadas_em.");
          ok++;
        } else {
          skipCompleto++;
          console.log("  ⏭️ Sem campos pendentes de extração — sem fetch de documents / modelo.");
        }
        continue;
      }

      const fileIds = await fetchEditalPdfKeys(supabase, edital.id);
      const ctxAll = await fetchDocumentsContextByEdital(supabase, edital.id, fileIds);
      console.log(`  📎 file_ids=${fileIds.length} ctx=${ctxAll.text.length} source=${ctxAll.sourceLabel}`);

      // Chunks com embedding (top-k) e todos os chunks com texto (janelas).
      const rows = await fetchDocumentsRows(supabase, { editalId: edital.id, fileIds });
      const rowsAll = await fetchDocumentsRowsAllWithContent(supabase, { editalId: edital.id, fileIds });
      const plainLen = buildPlainFullText(rowsAll).length;
      console.log(`  🔎 chunks_para_top_k=${rows.length} chunks_texto=${rowsAll.length} plain_chars=${plainLen} top_k=${topK()}`);

      const hasContextSample = hasNonEmptyContextText(ctxAll.text);
      const hasPlain = plainLen > 0;
      if (!hasPlain && !hasContextSample && rows.length === 0) {
        skipSemDocumentos++;
        console.log("  ⏭️ pulando: sem texto em `documents` nem amostra de contexto para este edital.");
        continue;
      }

      const patch: Record<string, any> = {};
      const evidenceAcc: Record<string, FieldEvidence> = {};
      const prevEvidence =
        edital.informacoes_extracao_evidence && typeof edital.informacoes_extracao_evidence === "object" && !Array.isArray(edital.informacoes_extracao_evidence)
          ? { ...edital.informacoes_extracao_evidence }
          : {};

      for (const f of fields) {
        const before = (edital as any)[f];
        if (!fieldNeedsExtraction(f, before)) continue;

        if (!hasPlain && !hasContextSample && rows.length === 0) {
          console.log(`\n  🧠 campo=${f} — sem texto nem embedding; pulando.`);
          continue;
        }

        const { value, rawJson, modelOutput, evidence } = await extractFieldWithTopKThenWindows(
          f,
          edital,
          rows,
          rowsAll,
          rows.length,
          ctxAll,
        );

        patch[f] = value;
        if (evidence && extractionValueIsUseful(f, value)) evidenceAcc[f] = evidence;

        const evLabel = evidence ? `evidence=${evidence.source}` : "evidence=nenhuma";
        console.log(`\n  🧠 campo=${f} ${evLabel}`);
        console.log(`  🧾 resposta_modelo (raw preview):\n${previewContext(modelOutput, 900)}`);
        console.log(`  🧾 json_extraido:\n${rawJson || "(vazio)"}`);
        console.log(
          `  ✅ resultado_${f}: ${value === null ? "null" : typeof value === "string" ? value.slice(0, 180) : JSON.stringify(value).slice(0, 400)}`,
        );
      }

      if (Object.keys(evidenceAcc).length > 0) {
        patch.informacoes_extracao_evidence = { ...prevEvidence, ...evidenceAcc };
      }

      if (Object.keys(patch).length === 0) {
        skipSemUpdateDb++;
        const aindaPendente = fields.some((f) => fieldNeedsExtraction(f, (edital as any)[f]));
        console.log(
          aindaPendente
            ? "  ⏭️ pulando update: há campos nulos, mas nenhum contexto/embedding por campo — edital continua na fila até haver `documents` ou embeddings."
            : "  ⏭️ pulando update: nenhum campo processável.",
        );
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

  const skipTotal = skipCompleto + skipSemDocumentos + skipSemUpdateDb;
  const accounted = ok + fail + skipTotal;
  console.log(
    `\n✅ done total_lote=${targets.length} ok=${ok} fail=${fail} skip_completo=${skipCompleto} skip_sem_documentos=${skipSemDocumentos} skip_sem_update_db=${skipSemUpdateDb} (ok+fail+skip=${accounted})`,
  );
  if (accounted !== targets.length) {
    console.warn(`⚠️ contagem não bate com total_lote (esperado ${targets.length}, soma ${accounted})`);
  }
  if (fail > 0 && !ecsWorkerLoopEnabled()) process.exitCode = 1;
  return { hadWork: targets.length > 0 };
}

async function main() {
  if (ecsWorkerLoopEnabled()) {
    let iter = 0;
    console.log(
      `🔄 ECS_WORKER_LOOP=1 — process-edital em ciclo contínuo. Idle após lote com itens=${workerIdleMsAfterWork()}ms; sem editais na fila=${workerIdleMsNoWork()}ms`,
    );
    while (true) {
      iter += 1;
      console.log(`\n🔄 worker iter=${iter} @ ${new Date().toISOString()}`);
      try {
        const { hadWork } = await runProcessBatch();
        const idle = hadWork ? workerIdleMsAfterWork() : workerIdleMsNoWork();
        if (idle > 0) await new Promise((r) => setTimeout(r, idle));
      } catch (e) {
        console.error("❌ worker iter:", e);
        await new Promise((r) => setTimeout(r, workerIdleMsNoWork()));
      }
    }
  }

  await runProcessBatch();
}

main().catch((e) => {
  console.error("❌ fatal:", e);
  process.exitCode = 1;
});

