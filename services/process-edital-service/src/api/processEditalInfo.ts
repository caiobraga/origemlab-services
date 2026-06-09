// Load env from repo/service .env when present.
import "../load-env";

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabase } from "../lib/supabase";
import {
  getMaxContextChars,
  getMaxFieldContextChars,
  getOllamaGenerateTimeoutMs,
  getTopKPackMaxChars,
  isOllamaRecoverableError,
  ollamaEmbed,
  ollamaGenerate,
} from "../lib/ollama";
import { initOllamaBaseUrl } from "../lib/ollamaResolve";
import { makeEventBase, publishDomainEvent } from "../lib/eventbridge";
import { mapPool, readConcurrencyEnv } from "../lib/concurrency.js";
import {
  isPrazoInscricaoMissing,
  normalizePrazoInscricaoFromText,
  reconcilePrazoInscricaoFromSources,
} from "../../../../shared/editalPrazoSync.ts";
import { extractValorLinesForStorage } from "../../../../shared/editalValorExtract.ts";

type FieldEvidence = {
  /** `topk` = similaridade; `chunkscan` = lotes sequenciais do documento; `bulk`/`window` = legado. */
  source: "topk" | "chunkscan" | "window" | "bulk";
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
  data_encerramento?: string | null;
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
  if (field === "timeline_estimada" || field === "valor_projeto") return "json";
  if (field === "is_researcher" || field === "is_company") return "boolean";
  return "string";
}

const VALOR_JSON_STORE_MAX = 1400;
const VALOR_LINE_MAX = 240;
const VALOR_ITEMS_MAX = 8;

/** Compacta valor_projeto para string JSON curta (evita parágrafos enormes no banco/UI). */
function normalizeValorProjetoForStorage(raw: unknown): string | null {
  if (raw == null) return null;

  const pushLine = (items: string[], line: string) => {
    const t = String(line || "").replace(/\s+/g, " ").trim();
    if (!t) return;
    items.push(t.length > VALOR_LINE_MAX ? `${t.slice(0, VALOR_LINE_MAX - 1)}…` : t);
  };

  const fromObject = (obj: any): string[] => {
    const items: string[] = [];
    const v = obj?.valor;
    if (Array.isArray(v)) {
      for (const x of v) {
        if (typeof x === "string") pushLine(items, x);
        else if (x && typeof x === "object" && x.valor != null) pushLine(items, String(x.valor));
      }
    } else if (typeof v === "string") {
      pushLine(items, v);
    }
    return items.slice(0, VALOR_ITEMS_MAX);
  };

  let items: string[] = [];
  if (typeof raw === "object" && raw !== null) {
    items = fromObject(raw);
  } else {
    const text = String(raw).replace(/\s+/g, " ").trim();
    if (!text) return null;
    const parsed = text.startsWith("{") ? safeJsonParse(text) : null;
    if (parsed && typeof parsed === "object") {
      items = fromObject(parsed);
    } else {
      const lines = extractValorLinesForStorage(text, VALOR_ITEMS_MAX, VALOR_LINE_MAX);
      if (lines.length > 1) {
        items = lines;
      } else if (text.length <= VALOR_LINE_MAX) {
        return text;
      } else if (lines.length === 1) {
        return lines[0];
      } else {
        return `${text.slice(0, VALOR_LINE_MAX - 1)}…`;
      }
    }
  }

  if (items.length === 0) return null;
  let out = JSON.stringify({ valor: items });
  if (out.length > VALOR_JSON_STORE_MAX) {
    const shorter = items.map((s) => (s.length > 120 ? `${s.slice(0, 119)}…` : s));
    out = JSON.stringify({ valor: shorter }).slice(0, VALOR_JSON_STORE_MAX);
  }
  return out;
}

function isNullishExtractedText(value: unknown): boolean {
  if (value == null) return true;
  const t = String(value).replace(/\s+/g, " ").trim().toLowerCase();
  if (!t) return true;
  return (
    t === "null" ||
    t === "undefined" ||
    t === "não informado" ||
    t === "nao informado" ||
    t === "não informado pelo edital" ||
    t === "nao informado pelo edital"
  );
}

/** Indica se o campo ainda deve passar pela extração (null, vazio, "Não informado", timeline vazia, boolean ausente). */
function fieldNeedsExtraction(field: FieldKey, before: any): boolean {
  if (field === "timeline_estimada" || field === "valor_projeto") {
    return !extractionValueIsUseful(field, before);
  }
  if (field === "is_researcher" || field === "is_company") {
    return typeof before !== "boolean";
  }
  if (fieldType(field) === "string") {
    return !extractionValueIsUseful(field, before);
  }
  return before === null || before === undefined;
}

function editalNeedsAnyFieldExtraction(edital: EditalInfo, fields: FieldKey[]): boolean {
  return fields.some((f) => fieldNeedsExtraction(f, (edital as any)[f]));
}

function editalHasAnyUsefulExtractedField(edital: EditalInfo, fields: FieldKey[]): boolean {
  return fields.some((f) => extractionValueIsUseful(f, (edital as any)[f]));
}

function patchHasUsefulExtractedField(patch: Record<string, any>, fields: FieldKey[]): boolean {
  return fields.some((f) => f in patch && extractionValueIsUseful(f, patch[f]));
}

function patchHasMeaningfulPrazo(patch: Record<string, any>): boolean {
  if (!("prazo_inscricao" in patch)) return false;
  return !isPrazoInscricaoMissing(patch.prazo_inscricao);
}

async function loadEditalCorretosIdSet(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from("editais_corretos").select("id");
  if (error) throw new Error(`Erro ao listar editais_corretos: ${error.message}`);
  return new Set((data ?? []).map((r: { id: string }) => String(r.id)));
}

function filterEditaisForProcessBatch(
  editais: EditalInfo[],
  fields: FieldKey[],
  opts: {
    backlogOnly: boolean;
    chunksOnly: boolean;
    weakOnly: boolean;
    corretosIds: Set<string>;
    chunkRank: Map<string, number> | null;
  },
): EditalInfo[] {
  let out = editais;
  if (opts.backlogOnly) {
    const before = out.length;
    out = out.filter((e) => !opts.corretosIds.has(e.id));
    console.log(`📋 PROCESS_EDITAL_BACKLOG_ONLY=1 — ${before} → ${out.length} (fora de editais_corretos)`);
  }
  if (opts.chunksOnly && opts.chunkRank?.size) {
    const before = out.length;
    out = out.filter((e) => opts.chunkRank!.has(e.id));
    console.log(`📋 PROCESS_EDITAL_CHUNKS_ONLY=1 — ${before} → ${out.length} (com chunks em documents)`);
  } else if (opts.chunksOnly && !opts.chunkRank?.size) {
    console.warn("⚠️ PROCESS_EDITAL_CHUNKS_ONLY=1 mas RPC de chunks indisponível — filtro ignorado.");
  }
  if (opts.weakOnly) {
    const before = out.length;
    out = out.filter((e) => editalNeedsAnyFieldExtraction(e, fields));
    console.log(`📋 PROCESS_EDITAL_WEAK_ONLY=1 — ${before} → ${out.length} (campos pendentes de extração)`);
  }
  return out;
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
    field === "valor_projeto"
      ? `{\"valor_projeto\":{\"valor\":[\"até R$ 500.000\",\"bolsa R$ 3.000/mês\"]}} ou {\"valor_projeto\":null}`
      : fieldType(field) === "json"
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
    ...(field === "valor_projeto"
      ? [
          "- valor_projeto: lista curta em \"valor\" (máx. 6 itens, cada um até ~120 caracteres); só valores/tetos/bolsas com evidência no texto",
          "- Não copie parágrafos inteiros do edital",
        ]
      : []),
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

/** Com vetores — queries pesadas; usar paginação e limites baixos. */
const DOCUMENTS_SELECT_WITH_EMBED = "id,file_id,content,metadata,embedding,embedding_perguntas";
/** Só texto — varredura por janelas (evita transferir embeddings gigantes). */
const DOCUMENTS_SELECT_CONTENT_ONLY = "id,file_id,content,metadata";

function documentsPageSize(): number {
  const n = parseInt(process.env.PROCESS_EDITAL_DOCUMENTS_PAGE_SIZE || "200", 10);
  return Number.isFinite(n) ? Math.max(50, Math.min(500, n)) : 200;
}

function documentsMaxRows(envKey: string, fallback: number): number {
  const raw = (process.env as Record<string, string | undefined>)[envKey];
  const n = raw != null && String(raw).trim() ? parseInt(String(raw), 10) : fallback;
  return Number.isFinite(n) ? Math.max(100, Math.min(5000, n)) : fallback;
}

function isSupabaseStatementTimeout(err: { message?: string } | null): boolean {
  const m = String(err?.message || "").toLowerCase();
  return m.includes("statement timeout") || m.includes("canceling statement");
}

/**
 * Busca chunks do edital: `metadata.edital_id` OU `file_id` ∈ edital_pdfs.
 * Pagina para evitar `statement timeout` em editais com muitos chunks + embeddings.
 */
async function fetchDocumentsForEdital(
  supabase: SupabaseClient,
  editalId: string,
  fileIds: string[],
  opts: { select: string; maxRows: number },
): Promise<any[]> {
  const eid = String(editalId).trim();
  const cleanFids = [...new Set(fileIds.map((x) => String(x).trim()).filter(Boolean))];
  const fidSet = new Set(cleanFids);
  const pageSize = documentsPageSize();
  const maxRows = opts.maxRows;
  const select = opts.select;

  const runPage = async (offset: number, pageLimit: number) => {
    const to = offset + pageLimit - 1;
    if (cleanFids.length > 0) {
      const orFilter = `metadata->>edital_id.eq.${eid},file_id.in.(${cleanFids.join(",")})`;
      return supabase.from("documents").select(select).or(orFilter).order("id", { ascending: true }).range(offset, to);
    }
    return supabase
      .from("documents")
      .select(select)
      .eq("metadata->>edital_id", eid)
      .order("id", { ascending: true })
      .range(offset, to);
  };

  const merged: any[] = [];
  const seen = new Set<string>();
  let offset = 0;

  while (merged.length < maxRows) {
    const pageLimit = Math.min(pageSize, maxRows - merged.length);
    let res: { data: any[] | null; error: { message?: string } | null } = await runPage(offset, pageLimit);
    if (res.error && isSupabaseStatementTimeout(res.error) && select !== DOCUMENTS_SELECT_CONTENT_ONLY) {
      const liteLimit = Math.min(150, pageLimit);
      console.warn(
        `⚠️ documents: statement timeout com embeddings — página ${offset} só content (${eid.slice(0, 8)}…)`,
      );
      const to = offset + liteLimit - 1;
      const liteRes =
        cleanFids.length > 0
          ? await supabase
              .from("documents")
              .select(DOCUMENTS_SELECT_CONTENT_ONLY)
              .or(`metadata->>edital_id.eq.${eid},file_id.in.(${cleanFids.join(",")})`)
              .order("id", { ascending: true })
              .range(offset, to)
          : await supabase
              .from("documents")
              .select(DOCUMENTS_SELECT_CONTENT_ONLY)
              .eq("metadata->>edital_id", eid)
              .order("id", { ascending: true })
              .range(offset, to);
      if (!liteRes.error) res = liteRes;
    }
    if (res.error) {
      if (isSupabaseStatementTimeout(res.error) && offset === 0) {
        throw new Error(
          `Erro ao buscar documents: ${res.error.message} — reduza PROCESS_EDITAL_DOCUMENTS_MAX_* ou aumente statement_timeout no Supabase; índices em metadata->>edital_id e file_id ajudam.`,
        );
      }
      throw new Error(`Erro ao buscar documents: ${res.error.message}`);
    }

    const batch = res.data ?? [];
    if (!batch.length) break;

    for (const r of batch) {
      const id = r?.id != null ? String(r.id) : "";
      if (!id || seen.has(id)) continue;
      if (!rowBelongsToEdital(r, eid, fidSet)) continue;
      seen.add(id);
      merged.push(r);
      if (merged.length >= maxRows) break;
    }

    if (batch.length < pageLimit) break;
    offset += pageLimit;
  }

  return merged;
}

async function fetchDocumentsContextByEdital(
  supabase: SupabaseClient,
  editalId: string,
  fileIds: string[],
): Promise<{ text: string; sourceLabel: string; documentIds: string[] }> {
  const raw = await fetchDocumentsForEdital(supabase, editalId, fileIds, {
    select: DOCUMENTS_SELECT_WITH_EMBED,
    maxRows: documentsMaxRows("PROCESS_EDITAL_DOCUMENTS_MAX_CONTEXT", 1200),
  });
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
  const raw = await fetchDocumentsForEdital(supabase, editalId, fileIds, {
    select: DOCUMENTS_SELECT_WITH_EMBED,
    maxRows: documentsMaxRows("PROCESS_EDITAL_DOCUMENTS_MAX_TOPK", 1200),
  });
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
  const raw = await fetchDocumentsForEdital(supabase, editalId, fileIds, {
    select: DOCUMENTS_SELECT_CONTENT_ONLY,
    maxRows: documentsMaxRows("PROCESS_EDITAL_DOCUMENTS_MAX_WINDOWS", 2500),
  });
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
  if (field === "valor_projeto") {
    if (value === null || (typeof value === "string" && isNullishExtractedText(value))) return false;
    const n = normalizeValorProjetoForStorage(value);
    return Boolean(n && !isNullishExtractedText(n));
  }
  if (field === "timeline_estimada") {
    return timelineValueIsUseful(value);
  }
  if (field === "is_researcher" || field === "is_company") return typeof value === "boolean";
  if (value === null) return false;
  if (typeof value === "string") return !isNullishExtractedText(value);
  return false;
}

const DATE_IN_TEXT =
  /\d{1,2}\s*\/\s*\d{1,2}\s*\/\s*\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+de\s+\w+\s+de\s+\d{4}/i;

function timelinePhaseHasDateSignal(fase: any): boolean {
  if (!fase || typeof fase !== "object") return false;
  for (const key of ["data_inicio", "data_fim", "fim", "prazo"] as const) {
    const t = String((fase as any)[key] ?? "").trim();
    if (!t || t.toLowerCase() === "null") continue;
    if (DATE_IN_TEXT.test(t)) return true;
  }
  return false;
}

/** Cronograma útil: ≥1 fase com data no texto; evita só “Inscrição” vazia + checklist de documentos. */
function timelineValueIsUseful(value: any): boolean {
  if (value === null) return false;
  const v = typeof value === "object" && value && "fases" in value ? value : null;
  if (!v || !Array.isArray((v as any).fases)) return false;
  const fases = (v as any).fases as any[];
  if (fases.length === 0) return false;
  const withDate = fases.filter(timelinePhaseHasDateSignal);
  if (withDate.length > 0) return true;
  const withNamedPhase = fases.filter((f) => {
    const nome = String(f?.nome || "").trim();
    if (nome.length < 4) return false;
    if (/documentos?\s+necess|anexos?\s+obrigat|checklist|modelo\s+de/i.test(nome)) return false;
    const prazo = String(f?.prazo || "").trim();
    return prazo.length > 0 && prazo.toLowerCase() !== "null";
  });
  return withNamedPhase.length >= 2;
}

function normalizeTimelineEstimada(raw: unknown): { fases: any[] } | null {
  if (raw == null) return null;
  let obj: any = raw;
  if (typeof raw === "string") {
    const parsed = safeJsonParse(raw);
    if (parsed && typeof parsed === "object") obj = parsed;
    else return null;
  }
  const fases = Array.isArray(obj?.fases) ? obj.fases : null;
  if (!fases?.length) return null;

  const cleaned = fases
    .map((f: any) => {
      const nome = String(f?.nome || "").trim().slice(0, 200);
      if (!nome) return null;
      const prazo = f?.prazo != null && String(f.prazo).trim() ? String(f.prazo).trim().slice(0, 120) : null;
      const status = f?.status != null && String(f.status).trim() ? String(f.status).trim().slice(0, 40) : null;
      const data_inicio =
        f?.data_inicio != null && String(f.data_inicio).trim() ? String(f.data_inicio).trim().slice(0, 32) : null;
      const data_fimRaw =
        f?.data_fim != null && String(f.data_fim).trim()
          ? String(f.data_fim).trim()
          : f?.fim != null && String(f.fim).trim()
            ? String(f.fim).trim()
            : "";
      const data_fim = data_fimRaw ? data_fimRaw.slice(0, 32) : null;
      return { nome, prazo, status, data_inicio, data_fim };
    })
    .filter(Boolean);

  if (cleaned.length === 0) return null;
  const out = { fases: cleaned };
  return timelineValueIsUseful(out) ? out : null;
}

function windowScanLargePlainThreshold(): number {
  return parseInt(process.env.PROCESS_EDITAL_WINDOW_LARGE_PLAIN_CHARS || "200000", 10) || 200_000;
}

/** Evita 20× generate em PDF de 400k+ chars quando top-k já rodou (causa timeout no NLB). */
function shouldRunWindowScan(
  field: FieldKey,
  opts: { topkFinished: boolean; topkTimedOut: boolean; plainLen: number },
): boolean {
  if (String(process.env.PROCESS_EDITAL_SKIP_WINDOWS || "").trim() === "1") {
    console.log(`  🪟 campo=${field}: janelas desligadas (PROCESS_EDITAL_SKIP_WINDOWS=1)`);
    return false;
  }

  if (opts.topkTimedOut) {
    console.log(
      `  🪟 campo=${field}: top-k interrompido por timeout — janelas permitidas (fallback, máx. reduzido)`,
    );
    return true;
  }

  if ((field === "is_researcher" || field === "is_company") && opts.topkFinished) {
    console.log(`  🪟 campo=${field}: pulando janelas (boolean; top-k concluiu sem resposta útil)`);
    return false;
  }

  const skipAfterTopk = String(process.env.PROCESS_EDITAL_SKIP_WINDOWS_AFTER_TOPK ?? "1").trim() !== "0";
  const large = windowScanLargePlainThreshold();
  if (skipAfterTopk && opts.topkFinished && opts.plainLen >= large) {
    const allowHuge = field === "timeline_estimada" || field === "prazo_inscricao";
    if (!allowHuge) {
      console.log(
        `  🪟 campo=${field}: pulando janelas (plain≥${large} e top-k concluiu sem resposta; timeline/prazo ainda usam janelas)`,
      );
      return false;
    }
  }

  return true;
}

function snippetFromContext(ctx: string): string {
  const max = Math.max(400, parseInt(process.env.PROCESS_EDITAL_EVIDENCE_SNIPPET_MAX || "2800", 10) || 2800);
  const t = String(ctx || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max);
}

function estimateRowsPlainChars(rows: any[]): number {
  let n = 0;
  for (const r of rows) {
    const t = String(r?.content || "").trim();
    if (t) n += t.length + (n > 0 ? 2 : 0);
  }
  return n;
}

/**
 * Editais com centenas de chunks: não montar 800k+ chars em memória nem varrer só o início.
 * Mantém ~20% início + ~20% fim + amostra do meio até PROCESS_EDITAL_WINDOW_MAX_PLAIN_BUILD.
 */
function subsampleRowsForWindowScan(rows: any[]): {
  rows: any[];
  truncated: boolean;
  originalChars: number;
  usedChars: number;
} {
  const sorted = sortRowsByChunkIndex(rows);
  const originalChars = estimateRowsPlainChars(sorted);
  const maxPlain = parseInt(process.env.PROCESS_EDITAL_WINDOW_MAX_PLAIN_BUILD || "320000", 10) || 320_000;
  if (originalChars <= maxPlain) {
    return { rows: sorted, truncated: false, originalChars, usedChars: originalChars };
  }

  const n = sorted.length;
  const headN = Math.max(1, Math.ceil(n * 0.22));
  const tailN = Math.max(1, Math.ceil(n * 0.22));
  const head = sorted.slice(0, headN);
  const tail = sorted.slice(n - tailN);
  const middle = sorted.slice(headN, n - tailN);

  const picked: any[] = [...head];
  let usedChars = estimateRowsPlainChars(picked);
  const tailChars = estimateRowsPlainChars(tail);
  const budgetMid = Math.max(0, maxPlain - usedChars - tailChars);

  if (budgetMid > 0 && middle.length > 0) {
    const avg = Math.max(80, Math.floor(estimateRowsPlainChars(middle) / middle.length));
    const step = Math.max(1, Math.ceil(middle.length / Math.max(1, Math.ceil(budgetMid / avg))));
    for (let i = 0; i < middle.length && usedChars < maxPlain - tailChars; i += step) {
      picked.push(middle[i]!);
      usedChars = estimateRowsPlainChars(picked);
    }
  }

  const seen = new Set<string>();
  const out: any[] = [];
  for (const r of [...picked, ...tail]) {
    const id = r?.id != null ? String(r.id) : "";
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(r);
  }

  const usedRows = sortRowsByChunkIndex(out);
  return {
    rows: usedRows,
    truncated: true,
    originalChars,
    usedChars: estimateRowsPlainChars(usedRows),
  };
}

/** Posições de janela espalhadas no texto (início, meio, fim) em vez de só as primeiras páginas. */
function computeSpreadWindowStarts(plainLen: number, windowSize: number, maxW: number): number[] {
  if (plainLen <= windowSize) return [0];
  const maxStart = plainLen - windowSize;
  if (maxW <= 1) return [0];
  const starts: number[] = [];
  for (let i = 0; i < maxW; i++) {
    const start = i === maxW - 1 ? maxStart : Math.round((maxStart * i) / (maxW - 1));
    if (!starts.length || start > starts[starts.length - 1]!) starts.push(start);
  }
  return starts.length ? starts : [0];
}

/** Limita janelas em PDFs enormes (ex. 500k+ chars) para não estourar timeout do Ollama por campo. */
function resolveWindowScanParams(
  plainLen: number,
  field: FieldKey,
  opts?: { topkFinished?: boolean; topkTimedOut?: boolean },
): {
  windowSize: number;
  overlap: number;
  maxWindows: number;
  useSpreadWindows: boolean;
} {
  let windowSize = Math.max(
    2000,
    Math.min(
      getMaxFieldContextChars(),
      parseInt(process.env.PROCESS_EDITAL_WINDOW_CHARS || String(Math.min(8000, getMaxFieldContextChars())), 10) || 8000,
    ),
  );
  let overlap = Math.max(0, parseInt(process.env.PROCESS_EDITAL_WINDOW_OVERLAP || "1000", 10) || 1000);
  let maxWindows = Math.max(1, parseInt(process.env.PROCESS_EDITAL_WINDOW_MAX_WINDOWS || "24", 10) || 24);
  let useSpreadWindows = false;

  const largePlain = windowScanLargePlainThreshold();
  const hugePlain = parseInt(process.env.PROCESS_EDITAL_WINDOW_HUGE_PLAIN_CHARS || "400000", 10) || 400_000;

  if (opts?.topkFinished) {
    maxWindows = Math.min(
      maxWindows,
      parseInt(process.env.PROCESS_EDITAL_WINDOW_MAX_AFTER_TOPK || "6", 10) || 6,
    );
  }

  if (opts?.topkTimedOut) {
    const afterTimeout = parseInt(process.env.PROCESS_EDITAL_WINDOW_MAX_AFTER_TOPK_TIMEOUT || "3", 10) || 3;
    maxWindows = Math.min(maxWindows, afterTimeout);
    if (field === "is_researcher" || field === "is_company") {
      const boolMax = parseInt(process.env.PROCESS_EDITAL_WINDOW_MAX_BOOLEAN_AFTER_TIMEOUT || "2", 10) || 2;
      maxWindows = Math.min(maxWindows, boolMax);
    }
  }

  if (plainLen >= hugePlain) {
    useSpreadWindows = true;
    maxWindows = Math.min(
      maxWindows,
      parseInt(process.env.PROCESS_EDITAL_WINDOW_MAX_WINDOWS_HUGE || "8", 10) || 8,
    );
    windowSize = Math.min(
      windowSize,
      parseInt(process.env.PROCESS_EDITAL_WINDOW_CHARS_HUGE || "10000", 10) || 10_000,
    );
    overlap = 0;
  } else if (plainLen >= largePlain) {
    maxWindows = Math.min(
      maxWindows,
      parseInt(process.env.PROCESS_EDITAL_WINDOW_MAX_WINDOWS_LARGE || "10", 10) || 10,
    );
    windowSize = Math.min(windowSize, parseInt(process.env.PROCESS_EDITAL_WINDOW_CHARS_LARGE || "8000", 10) || 8000);
    useSpreadWindows = true;
  }

  return { windowSize, overlap, maxWindows, useSpreadWindows };
}

function capContextForModel(context: string): string {
  const maxCtx = getMaxFieldContextChars();
  const t = String(context || "");
  if (t.length <= maxCtx) return t;
  return t.slice(0, maxCtx);
}

async function tryWindowScan(
  field: FieldKey,
  edital: EditalInfo,
  rowsAll: any[],
  opts?: { topkFinished?: boolean; topkTimedOut?: boolean },
): Promise<{ value: any; rawJson: string; modelOutput: string; evidence: FieldEvidence | null }> {
  const sampled = subsampleRowsForWindowScan(rowsAll);
  if (sampled.truncated) {
    console.log(
      `  🪟 texto para janelas: ${sampled.originalChars} → ${sampled.usedChars} chars (${sampled.rows.length}/${rowsAll.length} chunks; cap PROCESS_EDITAL_WINDOW_MAX_PLAIN_BUILD)`,
    );
  }

  const { plain, spans } = buildPlainWithSpans(sampled.rows);
  if (!plain.trim()) {
    return { value: null, rawJson: "", modelOutput: "", evidence: null };
  }

  const { windowSize, overlap, maxWindows: maxW, useSpreadWindows } = resolveWindowScanParams(plain.length, field, {
    topkFinished: opts?.topkFinished,
    topkTimedOut: opts?.topkTimedOut,
  });
  const maxCtx = getMaxContextChars();
  const effectiveWin = Math.min(windowSize, maxCtx);

  if (plain.length >= (parseInt(process.env.PROCESS_EDITAL_WINDOW_LARGE_PLAIN_CHARS || "200000", 10) || 200_000)) {
    console.log(
      `  🪟 janelas: plain=${plain.length} win=${effectiveWin} max=${maxW} modo=${useSpreadWindows ? "espalhado" : "deslizante"}`,
    );
  }

  let lastOut: { value: any; rawJson: string; modelOutput: string } = { value: null, rawJson: "", modelOutput: "" };

  const runWindow = async (start: number, wi: number) => {
    const end = Math.min(plain.length, start + effectiveWin);
    const slice = capContextForModel(plain.slice(start, end));
    if (!slice.trim()) return false;

    console.log(`  🪟 janela ${wi + 1}/${maxW} pos=${start}-${end} ctx_chars=${slice.length}`);
    let ex: { value: any; rawJson: string; modelOutput: string };
    try {
      ex = await extractFieldValue(field, edital, slice);
    } catch (e) {
      if (isOllamaRecoverableError(e)) {
        console.warn(`  🪟 janela ${wi + 1}: timeout no generate — abortando janelas restantes deste campo`);
        throw e;
      }
      throw e;
    }
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
          window_index: wi,
          ...docIdsEvidenceFields(docIds),
        },
      } as const;
    }
    return false;
  };

  const runWindowLoop = async (runOne: (wi: number) => Promise<false | { value: any; rawJson: string; modelOutput: string; evidence: FieldEvidence }>) => {
    for (let wi = 0; wi < maxW; wi++) {
      try {
        const hit = await runOne(wi);
        if (hit && typeof hit === "object" && "value" in hit) return hit;
      } catch (e) {
        if (isOllamaRecoverableError(e)) {
          return { value: null, rawJson: lastOut.rawJson, modelOutput: lastOut.modelOutput, evidence: null };
        }
        throw e;
      }
    }
    return null;
  };

  if (useSpreadWindows) {
    const starts = computeSpreadWindowStarts(plain.length, effectiveWin, maxW);
    const hit = await runWindowLoop(async (wi) => {
      if (wi >= starts.length) return false;
      return (await runWindow(starts[wi]!, wi)) as false | { value: any; rawJson: string; modelOutput: string; evidence: FieldEvidence };
    });
    if (hit) return hit;
  } else {
    let start = 0;
    const hit = await runWindowLoop(async (wi) => {
      if (start >= plain.length) return false;
      const result = await runWindow(start, wi);
      if (result && typeof result === "object" && "value" in result) return result;
      const end = Math.min(plain.length, start + effectiveWin);
      if (end >= plain.length) return false;
      const nextStart = end - overlap;
      start = nextStart <= start ? start + 1 : nextStart;
      return false;
    });
    if (hit) return hit;
  }

  return { value: null, rawJson: lastOut.rawJson, modelOutput: lastOut.modelOutput, evidence: null };
}

function topKSplitEnabled(): boolean {
  return String(process.env.PROCESS_EDITAL_TOPK_SPLIT ?? "1").trim() !== "0";
}

function topKBatchConfig(): { chunksPerBatch: number; maxCharsPerBatch: number; maxBatches: number } {
  const chunksPerBatch = parseInt(process.env.PROCESS_EDITAL_TOPK_BATCH_CHUNKS || "3", 10);
  const maxCharsPerBatch = parseInt(process.env.PROCESS_EDITAL_TOPK_BATCH_CHARS || "", 10);
  const maxBatches = parseInt(process.env.PROCESS_EDITAL_TOPK_MAX_BATCHES || "5", 10);
  return {
    chunksPerBatch: Number.isFinite(chunksPerBatch) ? Math.max(1, Math.min(12, chunksPerBatch)) : 3,
    maxCharsPerBatch:
      Number.isFinite(maxCharsPerBatch) && maxCharsPerBatch > 0
        ? maxCharsPerBatch
        : getMaxFieldContextChars(),
    maxBatches: Number.isFinite(maxBatches) ? Math.max(1, Math.min(20, maxBatches)) : 5,
  };
}

function fullDocChunkScanEnabled(): boolean {
  return String(process.env.PROCESS_EDITAL_FULLDOC_CHUNK_SCAN ?? "1").trim() !== "0";
}

function docScanBatchConfig(): { chunksPerBatch: number; maxCharsPerBatch: number; maxBatches: number } {
  const chunksRaw = parseInt(
    process.env.PROCESS_EDITAL_FULLDOC_BATCH_CHUNKS || process.env.PROCESS_EDITAL_TOPK_BATCH_CHUNKS || "3",
    10,
  );
  const charsRaw = parseInt(
    process.env.PROCESS_EDITAL_FULLDOC_BATCH_CHARS || process.env.PROCESS_EDITAL_TOPK_BATCH_CHARS || "",
    10,
  );
  const maxRaw = parseInt(process.env.PROCESS_EDITAL_FULLDOC_MAX_BATCHES || "0", 10);
  return {
    chunksPerBatch: Number.isFinite(chunksRaw) ? Math.max(1, Math.min(12, chunksRaw)) : 3,
    maxCharsPerBatch: Number.isFinite(charsRaw) && charsRaw > 0 ? charsRaw : getMaxFieldContextChars(),
    maxBatches: Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : 0,
  };
}

function buildDocumentChunkBatches(rowsAll: any[]): Array<{ rows: any[]; text: string; batchIndex: number }> {
  const { chunksPerBatch, maxCharsPerBatch, maxBatches } = docScanBatchConfig();
  const sorted = sortRowsByChunkIndex(
    rowsAll.filter((r) => typeof r?.content === "string" && String(r.content).trim().length > 0),
  );
  const batches: Array<{ rows: any[]; text: string; batchIndex: number }> = [];
  let batchRows: any[] = [];
  let batchPieces: string[] = [];

  const flush = () => {
    if (!batchRows.length) return;
    let text = batchPieces.join("\n\n");
    if (text.length > maxCharsPerBatch) text = text.slice(0, maxCharsPerBatch);
    batches.push({ rows: [...batchRows], text, batchIndex: batches.length });
    batchRows = [];
    batchPieces = [];
  };

  for (const r of sorted) {
    if (maxBatches > 0 && batches.length >= maxBatches) break;

    const piece = formatChunkBlock(r);
    const joinedLen = batchPieces.length ? batchPieces.join("\n\n").length + 2 + piece.length : piece.length;
    if (batchRows.length >= chunksPerBatch || (batchRows.length > 0 && joinedLen > maxCharsPerBatch)) {
      flush();
      if (maxBatches > 0 && batches.length >= maxBatches) break;
    }
    batchRows.push(r);
    batchPieces.push(piece);
  }
  if (maxBatches === 0 || batches.length < maxBatches) {
    flush();
  }

  return maxBatches > 0 ? batches.slice(0, maxBatches) : batches;
}

async function tryFullDocumentChunkScan(
  field: FieldKey,
  edital: EditalInfo,
  rowsAll: any[],
): Promise<{ value: any; rawJson: string; modelOutput: string; evidence: FieldEvidence | null }> {
  const batches = buildDocumentChunkBatches(rowsAll);
  if (batches.length === 0) {
    return { value: null, rawJson: "", modelOutput: "", evidence: null };
  }

  const cfg = docScanBatchConfig();
  console.log(
    `  📄 varredura documento campo=${field} lotes=${batches.length} chunks=${rowsAll.length} (${cfg.chunksPerBatch} chunks/lote, ordem leitura)`,
  );

  let lastEx: { value: any; rawJson: string; modelOutput: string } = {
    value: null,
    rawJson: "",
    modelOutput: "",
  };

  for (const batch of batches) {
    const bi = batch.batchIndex + 1;
    console.log(
      `  📄 doc lote ${bi}/${batches.length} campo=${field} chunks=${batch.rows.length} ctx_chars=${batch.text.length}`,
    );
    try {
      const ex = await extractFieldValue(field, edital, batch.text);
      lastEx = ex;
      if (extractionValueIsUseful(field, ex.value)) {
        const ci =
          typeof batch.rows[0]?.metadata?.chunk_index === "number" ? batch.rows[0].metadata.chunk_index : null;
        return {
          value: ex.value,
          rawJson: ex.rawJson,
          modelOutput: ex.modelOutput,
          evidence: {
            source: "chunkscan",
            snippet: snippetFromContext(batch.text),
            chunk_index: ci,
            ...docIdsEvidenceFields(documentIdsFromRows(batch.rows)),
          },
        };
      }
    } catch (e) {
      if (isOllamaRecoverableError(e)) {
        console.warn(`  📄 doc lote ${bi}/${batches.length}: timeout — próximo lote`);
        continue;
      }
      throw e;
    }
  }

  return {
    value: extractionValueIsUseful(field, lastEx.value) ? lastEx.value : null,
    rawJson: lastEx.rawJson,
    modelOutput: lastEx.modelOutput,
    evidence: null,
  };
}

/** Ranqueia chunks por cosseno (mesma lógica do top-k único). */
function rankRowsByQueryEmbedding(rows: any[], queryEmbedding: number[], k: number): Array<{ r: any; score: number }> {
  const scored = rows
    .map((r) => {
      const emb = embeddingVectorForTopKCompare(r);
      if (!emb) return null;
      return { r, score: cosineSimilarity(queryEmbedding, emb) };
    })
    .filter(Boolean) as Array<{ r: any; score: number }>;
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(5, Math.min(300, k)));
}

/**
 * Várias chamadas /api/generate com poucos chunks cada (NLB: 1× prompt grande estoura timeout).
 * Para no primeiro lote que devolver valor útil.
 */
async function tryTopKInBatches(
  field: FieldKey,
  edital: EditalInfo,
  rowsEmb: any[],
  queryEmbedding: number[],
  kOverride: number,
): Promise<{
  value: any;
  rawJson: string;
  modelOutput: string;
  evidence: FieldEvidence | null;
  lastEx: { value: any; rawJson: string; modelOutput: string };
  timedOut: boolean;
} | null> {
  const { chunksPerBatch, maxCharsPerBatch, maxBatches } = topKBatchConfig();
  const ranked = rankRowsByQueryEmbedding(rowsEmb, queryEmbedding, kOverride);
  if (ranked.length === 0) return null;

  let lastEx: { value: any; rawJson: string; modelOutput: string } = {
    value: null,
    rawJson: "",
    modelOutput: "",
  };
  let timedOut = false;

  const totalBatches = Math.min(maxBatches, Math.ceil(ranked.length / chunksPerBatch));
  for (let b = 0; b < totalBatches; b++) {
    const slice = ranked.slice(b * chunksPerBatch, b * chunksPerBatch + chunksPerBatch);
    if (slice.length === 0) break;

    const pieces = slice.map((s) => formatChunkBlock(s.r));
    let text = pieces.join("\n\n");
    if (text.length > maxCharsPerBatch) text = text.slice(0, maxCharsPerBatch);

    console.log(
      `  🔝 top-k lote ${b + 1}/${totalBatches} campo=${field} chunks=${slice.length} ctx_chars=${text.length} (max/batch=${maxCharsPerBatch})`,
    );

    let ex: { value: any; rawJson: string; modelOutput: string };
    try {
      ex = await extractFieldValue(field, edital, text);
    } catch (e) {
      if (isOllamaRecoverableError(e)) {
        timedOut = true;
        console.warn(
          `  🔝 top-k lote ${b + 1}: timeout (${getOllamaGenerateTimeoutMs()}ms) — próximo lote top-k`,
        );
        continue;
      }
      throw e;
    }
    lastEx = ex;
    if (extractionValueIsUseful(field, ex.value)) {
      const rowsUsed = slice.map((s) => s.r);
      return {
        value: ex.value,
        rawJson: ex.rawJson,
        modelOutput: ex.modelOutput,
        evidence: {
          source: "topk",
          snippet: snippetFromContext(text),
          ...docIdsEvidenceFields(documentIdsFromRows(rowsUsed)),
        },
        lastEx,
        timedOut: false,
      };
    }
  }

  return {
    value: null,
    rawJson: lastEx.rawJson,
    modelOutput: lastEx.modelOutput,
    evidence: null,
    lastEx,
    timedOut,
  };
}

function documentIdsFromRows(rows: any[]): string[] {
  const ids: string[] = [];
  for (const r of rows) {
    const id = r?.id != null ? String(r.id) : "";
    if (id) ids.push(id);
  }
  return [...new Set(ids)];
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

  /** Top-k concluiu (modelo respondeu, mesmo null) — pula bulk no meio. */
  let topkFinished = false;
  let topkTimedOut = false;

  // 1) Top-k (similaridade) quando há embeddings
  if (embCount > 0) {
    const query = buildFieldQuery(field, edital);
    let qEmb: number[];
    try {
      qEmb = await ollamaEmbed(query);
    } catch (e) {
      if (isOllamaRecoverableError(e)) {
        console.warn(`  🔝 top-k campo=${field}: embed timeout — pulando top-k`);
      } else {
        throw e;
      }
      qEmb = [];
    }
    const k = fieldTopK(field);

    if (qEmb.length > 0) {
      if (topKSplitEnabled()) {
        const batched = await tryTopKInBatches(field, edital, rowsEmb, qEmb, k);
        if (batched !== null) {
          lastEx = batched.lastEx;
          if (batched.timedOut) {
            topkTimedOut = true;
          } else {
            topkFinished = true;
          }
          if (extractionValueIsUseful(field, batched.value) && batched.evidence) {
            return {
              value: batched.value,
              rawJson: batched.rawJson,
              modelOutput: batched.modelOutput,
              evidence: batched.evidence,
            };
          }
        }
      } else {
        const top = buildTopKContext(rowsEmb, qEmb, { label: field, kOverride: k });
        if (hasNonEmptyContextText(top.text)) {
          topkFinished = true;
          console.log(`  🔝 top-k campo=${field} ctx_chars=${top.text.length} (${top.sourceLabel})`);
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
    }
  }

  // 2) Top-k não devolveu resposta útil → varredura sequencial de todo o documento em lotes de chunks
  if (fullDocChunkScanEnabled() && rowsAll.length > 0) {
    const scanned = await tryFullDocumentChunkScan(field, edital, rowsAll);
    lastEx = {
      value: scanned.value,
      rawJson: scanned.rawJson || lastEx.rawJson,
      modelOutput: scanned.modelOutput || lastEx.modelOutput,
    };
    if (extractionValueIsUseful(field, scanned.value) && scanned.evidence) {
      return {
        value: scanned.value,
        rawJson: scanned.rawJson,
        modelOutput: scanned.modelOutput,
        evidence: scanned.evidence,
      };
    }
  }

  // 3) Legado: janelas espalhadas (desligado por default — use PROCESS_EDITAL_USE_WINDOWS=1)
  if (String(process.env.PROCESS_EDITAL_USE_WINDOWS || "").trim() !== "1") {
    return {
      value: extractionValueIsUseful(field, lastEx.value) ? lastEx.value : null,
      rawJson: lastEx.rawJson,
      modelOutput: lastEx.modelOutput,
      evidence: null,
    };
  }

  const plainCharsTotal = estimateRowsPlainChars(rowsAll);
  if (!shouldRunWindowScan(field, { topkFinished, topkTimedOut, plainLen: plainCharsTotal })) {
    return {
      value: extractionValueIsUseful(field, lastEx.value) ? lastEx.value : null,
      rawJson: lastEx.rawJson,
      modelOutput: lastEx.modelOutput,
      evidence: null,
    };
  }
  console.log(
    `  🪟 campo=${field}: janelas | plain_chars_total=${plainCharsTotal} chunks=${rowsAll.length} topk_finished=${topkFinished} topk_timeout=${topkTimedOut}`,
  );
  const win = await tryWindowScan(field, edital, rowsAll, { topkFinished, topkTimedOut });
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

  const maxChars = getTopKPackMaxChars();
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
  const ctx = capContextForModel(context);
  // retry once if JSON is invalid / missing key
  const maxAttempts = Math.max(1, parseInt(process.env.PROCESS_EDITAL_JSON_RETRIES || "1", 10) || 1);
  let attempt = 0;
  let last: { value: any; rawJson: string; modelOutput: string } | null = null;
  while (attempt < maxAttempts) {
    const out = await generateStrictJson(field, edital, ctx);
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
        ctx || "(vazio)",
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
  if (t === "json") {
    if (field === "timeline_estimada") {
      const normalized = normalizeTimelineEstimada(value);
      return { value: normalized, rawJson, modelOutput };
    }
    if (field === "valor_projeto") {
      const normalized =
        normalizeValorProjetoForStorage(
          typeof value === "object" && value !== null ? value : typeof value === "string" ? value : null,
        );
      return { value: normalized, rawJson, modelOutput };
    }
    return { value: null, rawJson, modelOutput };
  }
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

async function updateEditalInfo(
  supabase: SupabaseClient,
  editalId: string,
  patch: Record<string, any>,
  fields: FieldKey[],
) {
  const updateData: Record<string, any> = { ...patch };
  const stampOnEmpty = String(process.env.PROCESS_EDITAL_STAMP_ON_EMPTY || "").trim() === "1";
  const shouldStamp =
    stampOnEmpty || patchHasUsefulExtractedField(patch, fields) || patchHasMeaningfulPrazo(patch);
  if (shouldStamp) {
    updateData.informacoes_processadas_em = new Date().toISOString();
  } else if (Object.keys(patch).length > 0) {
    console.log("  ℹ️ Patch sem campos úteis — gravando valores sem marcar informacoes_processadas_em.");
  }
  const { error } = await supabase.from("editais").update(updateData).eq("id", editalId);
  if (error) throw new Error(`Erro ao atualizar edital: ${error.message}`);
}

const NOTIFY_COMPONENT = "process-edital-service";

function baseEditalProps(edital: Pick<EditalInfo, "id" | "numero" | "titulo" | "fonte">): Record<string, unknown> {
  return {
    edital_id: edital.id,
    numero: edital.numero ?? null,
    titulo: edital.titulo,
    fonte: edital.fonte ?? null,
  };
}

/** Notificação DomainEvent → EventBridge (Telegram / error-reporter). Falhas aqui não interrompem o batch. */
async function notifyProcessSuccess(
  edital: EditalInfo,
  opts: { campos?: string[]; parcial?: boolean; stamp_only?: boolean },
): Promise<void> {
  try {
    const campos = opts.campos ?? [];
    const headline =
      opts.parcial !== true ? (opts.stamp_only ? "Data de processamento atualizada" : "Edital salvo") : "Gravação parcial";
    const summaryLabel = `${edital.numero || "—"} — ${edital.titulo}`;
    const message =
      campos.length > 0 ? `${headline}: ${summaryLabel} • Campos: ${campos.join(", ")}` : `${headline}: ${summaryLabel}`;
    const severity = opts.parcial === true ? "warn" : "info";
    const name =
      opts.parcial === true ? "ProcessEditalPartialSaved" : opts.stamp_only ? "ProcessEditalStamped" : "ProcessEditalSaved";
    await publishDomainEvent(
      makeEventBase({
        name,
        severity,
        message,
        component: NOTIFY_COMPONENT,
        props: {
          ...baseEditalProps(edital),
          campos,
          ...(opts.parcial === true ? { parcial: true } : {}),
          ...(opts.stamp_only ? { stamp_only: true } : {}),
        },
      }),
    );
  } catch (e) {
    console.warn(`⚠️ EventBridge (sucesso) ignorado: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function notifyProcessFailure(
  edital: Pick<EditalInfo, "id" | "numero" | "titulo" | "fonte">,
  err: unknown,
  extra?: { gravacaoParcialFallhou?: unknown; campos?: string[] },
): Promise<void> {
  try {
    const main = err instanceof Error ? err : new Error(String(err));
    const pes = `${edital.numero || edital.id} — ${edital.titulo}`;
    let message = `Falha ao processar edital (${pes}): ${main.message}`;
    const props: Record<string, unknown> = {
      ...baseEditalProps(edital),
      ...(extra?.campos?.length ? { campos_tentados: extra.campos } : {}),
    };
    if (extra?.gravacaoParcialFallhou != null) {
      const pe =
        extra.gravacaoParcialFallhou instanceof Error
          ? extra.gravacaoParcialFallhou.message
          : String(extra.gravacaoParcialFallhou);
      message += `. Gravação parcial também falhou: ${pe}`;
      props.gravacao_parcial_erro = pe;
      props.gravacao_parcial_disponivel = true;
    }
    await publishDomainEvent(
      makeEventBase({
        name: "ProcessEditalFailed",
        severity: "error",
        message,
        component: NOTIFY_COMPONENT,
        props,
        error: {
          type: main.name || "Error",
          message: main.message,
          stack: main.stack,
        },
      }),
    );
  } catch (e) {
    console.warn(`⚠️ EventBridge (erro) ignorado: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const EDITAIS_PROCESS_SELECT =
  "id,numero,titulo,fonte,criado_em,informacoes_processadas_em,informacoes_extracao_evidence,valor_projeto,prazo_inscricao,localizacao,vagas,is_researcher,is_company,sobre_programa,criterios_elegibilidade,timeline_estimada,data_encerramento";

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

type ProcessOneEditalOutcome =
  | { status: "ok"; stampOnly?: boolean; partial?: boolean }
  | { status: "skip_completo" }
  | { status: "skip_sem_documentos" }
  | { status: "skip_sem_update_db" }
  | { status: "fail" };

function applyPrazoReconcileToPatch(patch: Record<string, any>, edital: EditalInfo): boolean {
  const currentPrazo = patch.prazo_inscricao ?? edital.prazo_inscricao;
  const timeline = patch.timeline_estimada ?? edital.timeline_estimada;

  if (!isPrazoInscricaoMissing(currentPrazo)) {
    const normalized = normalizePrazoInscricaoFromText(currentPrazo);
    if (normalized && normalized !== currentPrazo) {
      patch.prazo_inscricao = normalized;
      return true;
    }
    return false;
  }

  const reconciled = reconcilePrazoInscricaoFromSources(currentPrazo, timeline, edital.data_encerramento);
  if (!reconciled) return false;
  patch.prazo_inscricao = reconciled;
  return true;
}

async function persistReconciledPrazoIfNeeded(
  supabase: SupabaseClient,
  edital: EditalInfo,
  tag: string,
  fields: FieldKey[],
): Promise<boolean> {
  if (!isPrazoInscricaoMissing(edital.prazo_inscricao)) {
    const normalized = normalizePrazoInscricaoFromText(edital.prazo_inscricao);
    if (normalized && normalized !== edital.prazo_inscricao) {
      await updateEditalInfo(supabase, edital.id, { prazo_inscricao: normalized }, fields);
      console.log(`  ${tag} 📅 prazo_inscricao normalizado: ${normalized}`);
      return true;
    }
    return false;
  }
  const reconciled = reconcilePrazoInscricaoFromSources(
    edital.prazo_inscricao,
    edital.timeline_estimada,
    edital.data_encerramento,
  );
  if (!reconciled) return false;
  await updateEditalInfo(supabase, edital.id, { prazo_inscricao: reconciled }, fields);
  console.log(`  ${tag} 📅 prazo_inscricao derivado da timeline: ${reconciled}`);
  return true;
}

async function processOneEdital(
  supabase: SupabaseClient,
  edital: EditalInfo,
  fields: FieldKey[],
  fieldConcurrency: number,
): Promise<ProcessOneEditalOutcome> {
  const tag = `[${edital.numero || edital.id.slice(0, 8)}]`;
  console.log(`\n🧾 ${tag} — ${edital.titulo} (${edital.fonte || "N/A"})`);
  console.log(`  🆔 edital_id=${edital.id}`);

  let patch: Record<string, any> = {};
  let evidenceAcc: Record<string, FieldEvidence> = {};
  let prevEvidence: Record<string, FieldEvidence> = {};

  try {
    if (!editalNeedsAnyFieldExtraction(edital, fields)) {
      const prazoFixed = await persistReconciledPrazoIfNeeded(supabase, edital, tag, fields);
      if (!(edital as any).informacoes_processadas_em) {
        const { error: stampErr } = await supabase
          .from("editais")
          .update({ informacoes_processadas_em: new Date().toISOString() })
          .eq("id", edital.id);
        if (stampErr) throw new Error(`Erro ao marcar informacoes_processadas_em: ${stampErr.message}`);
        console.log(`  ${tag} ℹ️ Campos extraíveis já preenchidos — gravando informacoes_processadas_em.`);
        await notifyProcessSuccess(edital, { stamp_only: true, ...(prazoFixed ? { campos: ["prazo_inscricao"] } : {}) });
        return { status: "ok", stampOnly: true };
      }
      if (prazoFixed) {
        await notifyProcessSuccess(edital, { campos: ["prazo_inscricao"] });
        return { status: "ok" };
      }
      console.log(`  ${tag} ⏭️ Sem campos pendentes de extração — sem fetch de documents / modelo.`);
      return { status: "skip_completo" };
    }

    patch = {};
    evidenceAcc = {};
    prevEvidence =
      edital.informacoes_extracao_evidence &&
      typeof edital.informacoes_extracao_evidence === "object" &&
      !Array.isArray(edital.informacoes_extracao_evidence)
        ? { ...edital.informacoes_extracao_evidence }
        : {};

    const fileIds = await fetchEditalPdfKeys(supabase, edital.id);
    const ctxAll = await fetchDocumentsContextByEdital(supabase, edital.id, fileIds);
    console.log(`  ${tag} 📎 file_ids=${fileIds.length} ctx=${ctxAll.text.length} source=${ctxAll.sourceLabel}`);

    const rows = await fetchDocumentsRows(supabase, { editalId: edital.id, fileIds });
    const rowsAll = await fetchDocumentsRowsAllWithContent(supabase, { editalId: edital.id, fileIds });
    const plainLen = buildPlainFullText(rowsAll).length;
    console.log(
      `  ${tag} 🔎 chunks_para_top_k=${rows.length} chunks_texto=${rowsAll.length} plain_chars=${plainLen} top_k=${topK()}`,
    );

    const hasContextSample = hasNonEmptyContextText(ctxAll.text);
    const hasPlain = plainLen > 0;
    if (!hasPlain && !hasContextSample && rows.length === 0) {
      console.log(`  ${tag} ⏭️ pulando: sem texto em documents nem amostra de contexto.`);
      return { status: "skip_sem_documentos" };
    }

    const fieldsToRun = fields.filter((f) => fieldNeedsExtraction(f, (edital as any)[f]));
    const runField = async (f: FieldKey) => {
      if (!hasPlain && !hasContextSample && rows.length === 0) {
        console.log(`\n  ${tag} 🧠 campo=${f} — sem texto nem embedding; pulando.`);
        return null;
      }
      try {
        const { value, rawJson, modelOutput, evidence } = await extractFieldWithTopKThenWindows(
          f,
          edital,
          rows,
          rowsAll,
          rows.length,
          ctxAll,
        );
        const evLabel = evidence ? `evidence=${evidence.source}` : "evidence=nenhuma";
        console.log(`\n  ${tag} 🧠 campo=${f} ${evLabel}`);
        console.log(`  ${tag} 🧾 resposta_modelo (raw preview):\n${previewContext(modelOutput, 900)}`);
        console.log(`  ${tag} 🧾 json_extraido:\n${rawJson || "(vazio)"}`);
        console.log(
          `  ${tag} ✅ resultado_${f}: ${value === null ? "null" : typeof value === "string" ? value.slice(0, 180) : JSON.stringify(value).slice(0, 400)}`,
        );
        return { f, value, evidence };
      } catch (e) {
        if (isOllamaRecoverableError(e)) {
          console.warn(
            `  ${tag} ⚠️ campo=${f}: timeout Ollama (${getOllamaGenerateTimeoutMs()}ms) — campo ignorado; edital continua`,
          );
          return { f, value: null, evidence: undefined };
        }
        throw e;
      }
    };

    const fieldOutcomes =
      fieldConcurrency > 1 && fieldsToRun.length > 1
        ? await mapPool(fieldsToRun, fieldConcurrency, runField)
        : await Promise.all(fieldsToRun.map((f) => runField(f)));

    for (const row of fieldOutcomes) {
      if (!row) continue;
      patch[row.f] = row.value;
      if (row.evidence && extractionValueIsUseful(row.f, row.value)) {
        evidenceAcc[row.f] = row.evidence;
      }
    }

    if (Object.keys(evidenceAcc).length > 0) {
      patch.informacoes_extracao_evidence = { ...prevEvidence, ...evidenceAcc };
    }

    if (applyPrazoReconcileToPatch(patch, edital)) {
      console.log(`  ${tag} 📅 prazo_inscricao derivado da timeline: ${patch.prazo_inscricao}`);
    }

    if (Object.keys(patch).length === 0) {
      const prazoFixed = await persistReconciledPrazoIfNeeded(supabase, edital, tag, fields);
      if (prazoFixed) {
        await notifyProcessSuccess(edital, { campos: ["prazo_inscricao"] });
        return { status: "ok" };
      }
      const aindaPendente = fields.some((f) => fieldNeedsExtraction(f, (edital as any)[f]));
      console.log(
        `  ${tag} ⏭️ pulando update: ${
          aindaPendente
            ? "há campos nulos, mas sem contexto/embedding por campo"
            : "nenhum campo processável"
        }`,
      );
      return { status: "skip_sem_update_db" };
    }

    await updateEditalInfo(supabase, edital.id, patch, fields);
    const camposSalvos = Object.keys(patch).filter((k) => k !== "informacoes_extracao_evidence");
    await notifyProcessSuccess(edital, { campos: camposSalvos });
    console.log(`  ${tag} ✅ atualizado`);
    return { status: "ok" };
  } catch (e) {
    if (Object.keys(evidenceAcc).length > 0) {
      patch.informacoes_extracao_evidence = { ...prevEvidence, ...evidenceAcc };
    }
    const fieldKeys = Object.keys(patch).filter((k) => k !== "informacoes_extracao_evidence");
    if (fieldKeys.length > 0) {
      try {
        await updateEditalInfo(supabase, edital.id, patch, fields);
        console.warn(
          `  ${tag} ⚠️ Gravação parcial (${fieldKeys.join(", ")}) — erro posterior: ${e instanceof Error ? e.message : String(e)}`,
        );
        await notifyProcessSuccess(edital, { campos: fieldKeys, parcial: true });
        return { status: "ok", partial: true };
      } catch (persistErr) {
        console.error(
          `  ${tag} ❌ erro:`,
          e instanceof Error ? e.message : String(e),
          "| gravar parcial falhou:",
          persistErr instanceof Error ? persistErr.message : String(persistErr),
        );
        await notifyProcessFailure(edital, e, { gravacaoParcialFallhou: persistErr, campos: fieldKeys });
        return { status: "fail" };
      }
    }
    console.error(`  ${tag} ❌ erro:`, e instanceof Error ? e.message : String(e));
    await notifyProcessFailure(edital, e);
    return { status: "fail" };
  }
}

export async function runProcessBatch(): Promise<{ hadWork: boolean }> {
  await initOllamaBaseUrl();

  const supabase = createSupabase();

  const limitRaw = parseInt(process.env.PROCESS_EDITAL_LIMIT || "0", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity;
  const editalConcurrency = readConcurrencyEnv("PROCESS_EDITAL_CONCURRENCY", 1, 6);
  const fieldConcurrency = readConcurrencyEnv("PROCESS_EDITAL_FIELD_CONCURRENCY", 1, 4);
  const delayDefault = editalConcurrency > 1 ? "0" : "2000";
  const delayBetweenEditaisMs = Math.max(
    0,
    parseInt(process.env.DELAY_BETWEEN_EDITAIS_MS || delayDefault, 10) || 0,
  );
  const onlyId = String(process.env.PROCESS_EDITAL_ONLY_ID || "").trim();
  const backlogOnly = String(process.env.PROCESS_EDITAL_BACKLOG_ONLY || "").trim() === "1";
  const chunksOnly = String(process.env.PROCESS_EDITAL_CHUNKS_ONLY || "").trim() === "1";
  const weakOnly = String(process.env.PROCESS_EDITAL_WEAK_ONLY || "").trim() === "1";

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
    `📦 limit=${Number.isFinite(limit) ? limit : "∞"} editalConcurrency=${editalConcurrency} fieldConcurrency=${fieldConcurrency} delayBetweenEditaisMs=${delayBetweenEditaisMs} order=${String(process.env.PROCESS_EDITAL_ORDER || "pending_first").trim() || "pending_first"} backlogOnly=${backlogOnly} chunksOnly=${chunksOnly} weakOnly=${weakOnly}`,
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
  } else if (backlogOnly || chunksOnly || weakOnly) {
    const corretosIds = backlogOnly ? await loadEditalCorretosIdSet(supabase) : new Set<string>();
    editais = filterEditaisForProcessBatch(editais, fields, {
      backlogOnly,
      chunksOnly,
      weakOnly,
      corretosIds,
      chunkRank,
    });
  }
  applyProcessEditalOrdering(editais, fields, chunkRank);
  const targets = Number.isFinite(limit) ? editais.slice(0, limit) : editais;
  console.log(
    `📥 editais carregados=${loadedFromDb}${onlyId ? ` (após only_id: ${editais.length})` : ""}${backlogOnly || chunksOnly || weakOnly ? ` (após filtros: ${editais.length})` : ""} a processar neste lote=${targets.length}`,
  );

  let ok = 0;
  let fail = 0;
  let skipCompleto = 0;
  let skipSemDocumentos = 0;
  let skipSemUpdateDb = 0;

  const processTargets = async (edital: EditalInfo) => {
    const outcome = await processOneEdital(supabase, edital, fields, fieldConcurrency);
    switch (outcome.status) {
      case "ok":
        ok++;
        break;
      case "skip_completo":
        skipCompleto++;
        break;
      case "skip_sem_documentos":
        skipSemDocumentos++;
        break;
      case "skip_sem_update_db":
        skipSemUpdateDb++;
        break;
      case "fail":
        fail++;
        break;
      default:
        break;
    }
  };

  if (editalConcurrency > 1 && targets.length > 1) {
    const batchDelay = delayBetweenEditaisMs;
    const chunkSize = editalConcurrency;
    for (let start = 0; start < targets.length; start += chunkSize) {
      const chunk = targets.slice(start, start + chunkSize);
      await Promise.all(chunk.map((edital) => processTargets(edital)));
      if (batchDelay > 0 && start + chunkSize < targets.length) {
        await new Promise((r) => setTimeout(r, batchDelay));
      }
    }
  } else {
    for (let i = 0; i < targets.length; i++) {
      await processTargets(targets[i]!);
      if (i < targets.length - 1 && delayBetweenEditaisMs > 0) {
        await new Promise((r) => setTimeout(r, delayBetweenEditaisMs));
      }
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

const isDirectCliRun =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectCliRun) {
  main().catch((e) => {
    console.error("❌ fatal:", e);
    process.exitCode = 1;
  });
}

