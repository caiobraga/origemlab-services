import "../load-env";

import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabase } from "../lib/supabase";
import { getMaxAuditContextChars, isOllamaTimeout, ollamaGenerate } from "../lib/ollama";
import { initOllamaBaseUrl } from "../lib/ollamaResolve";
import { mapPool, readConcurrencyEnv } from "../lib/concurrency.js";
import {
  editalHasActiveDeadline,
  isPrazoInscricaoMissing,
  normalizePrazoInscricaoFromText,
  reconcilePrazoInscricaoFromSources,
} from "../../../../shared/editalPrazoSync.ts";

type FieldEvidence = {
  source: "topk" | "chunkscan" | "window" | "bulk";
  snippet: string;
  document_ids?: string[];
  document_id?: string | null;
  chunk_index?: number | null;
  window_index?: number | null;
};

type EditalRow = {
  id: string;
  numero: string | null;
  titulo: string;
  descricao: string | null;
  processado_em: string | null;
  criado_em: string;
  atualizado_em: string | null;
  data_publicacao: string | null;
  data_encerramento: string | null;
  status: string | null;
  valor: string | null;
  area: string | null;
  orgao: string | null;
  fonte: string;
  link: string | null;
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

const EXTRACTED_FIELDS: FieldKey[] = [
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

function normalizeMaybeString(s: any): string | null {
  if (s == null) return null;
  const t = String(s).replace(/\s+/g, " ").trim();
  if (!t.length) return null;
  if (t.toLowerCase() === "não informado") return null;
  return t;
}

function hasMeaningfulExtractedValue(field: FieldKey, value: any): boolean {
  if (value === null || value === undefined) return false;
  const t = fieldType(field);
  if (t === "boolean") return typeof value === "boolean";
  if (t === "json") {
    const unwrapped = unwrapJsonLayers(value);
    if (unwrapped && typeof unwrapped === "object" && Array.isArray((unwrapped as any).fases)) {
      return (unwrapped as any).fases.length > 0;
    }
    return false;
  }
  return normalizeMaybeString(value) != null;
}

/** Campos críticos são auditados mesmo com valor vazio/"Não informado" (tentativa de extração no PDF). */
function fieldNeedsAudit(field: FieldKey, before: any): boolean {
  if (
    field === "prazo_inscricao" ||
    field === "valor_projeto" ||
    field === "sobre_programa" ||
    field === "criterios_elegibilidade"
  ) {
    return true;
  }
  if (field === "timeline_estimada") {
    return hasMeaningfulExtractedValue(field, before);
  }
  if (field === "is_researcher" || field === "is_company") {
    return typeof before === "boolean";
  }
  return hasMeaningfulExtractedValue(field, before);
}

function listNonNullExtractedFields(edital: EditalRow): FieldKey[] {
  return EXTRACTED_FIELDS.filter((field) => hasMeaningfulExtractedValue(field, (edital as any)[field]));
}

function unwrapJsonLayers(v: any): any {
  let cur = v;
  for (let i = 0; i < 3; i++) {
    if (cur && typeof cur === "object" && "json" in cur) cur = (cur as any).json;
  }
  return cur;
}

function hasAnyDateSignalInText(t: string): boolean {
  const s = String(t || "").trim();
  if (!s) return false;
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(s)) return true;
  if (/\b\d{1,2}\s+de\s+[a-zA-ZÀ-ÿçÇ]+\s+de\s+\d{4}\b/i.test(s)) return true;
  if (/\b\d{1,2}[\/\-.]\d{1,2}[\/\-.]\d{4}\b/.test(s)) return true;
  return false;
}

function dateFromEncerramento(dataEnc: string | null | undefined): Date | null {
  if (!dataEnc) return null;
  const d = new Date(String(dataEnc).trim());
  return isNaN(d.getTime()) ? null : d;
}

function reconcilePrazoInscricao(prazo: any, timeline: any, dataEncerramento?: string | null): string | null {
  if (!isPrazoInscricaoMissing(prazo) && hasMeaningfulExtractedValue("prazo_inscricao", prazo)) {
    return canonicalizePrazoInscricaoForSite(prazo);
  }
  return reconcilePrazoInscricaoFromSources(prazo, timeline, dataEncerramento);
}

function assessEditalCorretoPresentable(row: {
  titulo: string;
  descricao?: string | null;
  sobre_programa?: string | null;
  link?: string | null;
  fonte: string;
  is_researcher?: boolean | null;
  is_company?: boolean | null;
  data_encerramento?: string | null;
  prazo_inscricao?: string | null;
  timeline_estimada?: any;
  criado_em?: string | null;
}): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const minResumo = Math.max(20, parseInt(process.env.VALIDATE_MIN_RESUMO_CHARS || "50", 10) || 50);

  const titulo = String(row.titulo || "").trim();
  if (titulo.length < 5) reasons.push("titulo_curto");

  const link = String(row.link || "").trim();
  if (!/^https?:\/\//i.test(link)) reasons.push("link_invalido");

  if (!String(row.fonte || "").trim()) reasons.push("fonte_ausente");

  const resumo = String(row.sobre_programa || row.descricao || "").trim();
  if (resumo.length < minResumo) reasons.push("resumo_insuficiente");

  if (row.is_researcher === false && row.is_company === false) {
    reasons.push("publico_alvo_exclui_pesquisador_e_empresa");
  }

  if (!hasMeaningfulExtractedValue("prazo_inscricao", row.prazo_inscricao)) {
    const hasDeadline = editalHasActiveDeadline({
      titulo: row.titulo,
      descricao: row.descricao,
      sobre_programa: row.sobre_programa,
      timeline_estimada: row.timeline_estimada,
      prazo_inscricao: row.prazo_inscricao,
      data_encerramento: row.data_encerramento,
      criado_em: row.criado_em,
      status: (row as { status?: string | null }).status,
    });
    if (!hasDeadline) reasons.push("sem_prazo_inscricao");
  }

  if (
    !editalHasActiveDeadline({
      titulo: row.titulo,
      descricao: row.descricao,
      sobre_programa: row.sobre_programa,
      timeline_estimada: row.timeline_estimada,
      prazo_inscricao: row.prazo_inscricao,
      data_encerramento: row.data_encerramento,
      criado_em: row.criado_em,
      status: (row as { status?: string | null }).status,
    })
  ) {
    reasons.push("prazo_encerrado");
  }

  return { ok: reasons.length === 0, reasons };
}

async function fetchEditalPdfKeys(supabase: SupabaseClient, editalId: string): Promise<string[]> {
  const { data, error } = await supabase.from("edital_pdfs").select("file_id, id").eq("edital_id", editalId);
  if (error) throw new Error(`Erro ao buscar edital_pdfs: ${error.message}`);
  const keys = (data ?? []).map((r: any) => String(r.file_id || r.id || "").trim()).filter(Boolean);
  return [...new Set(keys)];
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

  while (Array.isArray(cur) && cur.length === 1 && Array.isArray(cur[0])) {
    cur = cur[0];
  }

  if (!Array.isArray(cur) || cur.length === 0) return null;

  const nums = cur.map((x) => Number(x));
  if (nums.length < 4) return null;
  if (nums.some((n) => !Number.isFinite(n))) return null;
  return nums;
}

function rowHasAnyEmbeddingRow(r: any): boolean {
  return asEmbedding(r?.embedding_perguntas) != null || asEmbedding(r?.embedding) != null;
}

/** Alinhado a `processEditalInfo.ts` — dedupe por `documents.id`. */
function dedupeDocumentsById(rows: any[]): any[] {
  const m = new Map<string, any>();
  for (const r of rows ?? []) {
    if (r?.id != null) m.set(String(r.id), r);
  }
  return [...m.values()];
}

/** Chunk pertence ao edital: `metadata.edital_id` ou `file_id` (coluna ou metadata) ∈ edital_pdfs. */
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

const VALIDATE_DOCUMENTS_SELECT = "id,file_id,content,metadata,embedding,embedding_perguntas";

/**
 * Mesma estratégia que `fetchDocumentsForEdital` em process-edital: `.or(metadata->>edital_id, file_id ∈ pdfs)`
 * e filtro `rowBelongsToEdital` (evita perder chunks só ligados por metadata ou `metadata.file_id`).
 */
async function fetchDocumentsForEditalValidate(
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
    const res = await supabase.from("documents").select(VALIDATE_DOCUMENTS_SELECT).or(orFilter).limit(limit);
    data = res.data;
    error = res.error;
  } else {
    const res = await supabase
      .from("documents")
      .select(VALIDATE_DOCUMENTS_SELECT)
      .eq("metadata->>edital_id", eid)
      .limit(limit);
    data = res.data;
    error = res.error;
  }

  if (error) throw new Error(`Erro ao buscar documents: ${error.message}`);
  const merged = dedupeDocumentsById(data ?? []);
  return merged.filter((r) => rowBelongsToEdital(r, eid, fidSet));
}

function sortDocumentRows(rows: any[]): any[] {
  return [...rows].sort((a: any, b: any) => {
    const ia = typeof a?.metadata?.chunk_index === "number" ? a.metadata.chunk_index : -1;
    const ib = typeof b?.metadata?.chunk_index === "number" ? b.metadata.chunk_index : -1;
    if (ia !== ib) return ia - ib;
    return String(a.id).localeCompare(String(b.id));
  });
}

async function fetchRawDocumentRows(
  supabase: SupabaseClient,
  editalId: string,
  fileIds: string[],
): Promise<any[]> {
  const chunkLimit = Math.max(200, parseInt(process.env.VALIDATE_DOCUMENTS_LIMIT || "3000", 10) || 3000);
  const raw = await fetchDocumentsForEditalValidate(supabase, editalId, fileIds, chunkLimit);
  return raw.filter((r: any) => typeof r?.content === "string" && r.content.trim().length > 0);
}

function formatChunkBlock(r: any): string {
  const fid = String(r.file_id || r.metadata?.file_id || r.id).slice(0, 12);
  const ci = typeof r?.metadata?.chunk_index === "number" ? r.metadata.chunk_index : "?";
  return `--- Documento ${fid} / chunk ${ci} ---\n${String(r.content).trim()}`;
}

function auditBatchConfig(): { chunksPerBatch: number; maxCharsPerBatch: number } {
  const chunksRaw = parseInt(
    process.env.VALIDATE_AUDIT_BATCH_CHUNKS || process.env.PROCESS_EDITAL_TOPK_BATCH_CHUNKS || "3",
    10,
  );
  const charsRaw = parseInt(
    process.env.VALIDATE_AUDIT_BATCH_CHARS || process.env.PROCESS_EDITAL_TOPK_BATCH_CHARS || "",
    10,
  );
  return {
    chunksPerBatch: Number.isFinite(chunksRaw) ? Math.max(1, Math.min(12, chunksRaw)) : 3,
    maxCharsPerBatch:
      Number.isFinite(charsRaw) && charsRaw > 0 ? charsRaw : getMaxAuditContextChars(),
  };
}

function buildAuditChunkBatches(rows: any[]): Array<{ rows: any[]; text: string; batchIndex: number }> {
  const { chunksPerBatch, maxCharsPerBatch } = auditBatchConfig();
  const maxBatchesRaw = parseInt(
    process.env.VALIDATE_AUDIT_MAX_BATCHES || process.env.PROCESS_EDITAL_FULLDOC_MAX_BATCHES || "0",
    10,
  );
  const maxBatches = Number.isFinite(maxBatchesRaw) && maxBatchesRaw > 0 ? maxBatchesRaw : 0;
  const sorted = sortDocumentRows(
    rows.filter((r) => typeof r?.content === "string" && String(r.content).trim().length > 0),
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

function auditChunkScanEnabled(): boolean {
  return String(process.env.VALIDATE_AUDIT_CHUNK_SCAN ?? "1").trim() !== "0";
}

function makeAuditPrompt(
  field: FieldKey,
  edital: EditalRow,
  before: any,
  evidence: FieldEvidence | undefined,
): string {
  const beforeText = before === null || before === undefined ? "null" : JSON.stringify(before);
  const idsLine =
    evidence && (evidence.document_ids?.length || evidence.document_id)
      ? `\nIDs em documents (linhas da extração): ${(evidence.document_ids?.length ? evidence.document_ids : [evidence.document_id]).filter(Boolean).join(", ")}`
      : "";
  const evidenceBlock =
    evidence && typeof evidence.snippet === "string" && evidence.snippet.trim()
      ? `Trecho usado na extração (origem: ${evidence.source}):\n${evidence.snippet.slice(0, 6000)}${idsLine}`
      : "Não há trecho de evidência registrado (extração antiga). Use somente o documento abaixo.";

  return [
    "Você audita um valor já extraído de um edital.",
    "Tarefas:",
    "(1) Percorra o DOCUMENTO e verifique se existe, em outra parte do texto, informação mais específica, completa ou claramente melhor para o MESMO campo (não confunda com outros campos).",
    "(2) Verifique se o valor está correto e sustentado pelo texto; se estiver vago, contraditório ou sem suporte, corrija ou anule.",
    "Decisão em _audit.decision:",
    '- "accept": o valor está adequado (pode devolver equivalente).',
    '- "replace": há informação melhor no documento — preencha o campo com o melhor valor suportado.',
    '- "reject": não há suporte no documento — use null no campo.',
    "Não invente dados que não apareçam no documento.",
    "",
    `Edital: ${edital.numero || "N/A"} — ${edital.titulo}`,
    `Fonte: ${edital.fonte}`,
    "",
    `Campo: ${field}`,
    `Valor atual (extração): ${beforeText}`,
    "",
    evidenceBlock,
    "",
    "Orientação do campo:",
    FIELD_PRESENTATION_GUIDANCE[field],
    "",
    "Formato de saída: APENAS JSON válido (uma linha se possível) com:",
    `- a chave do campo "${field}" com o valor final (tipo correto: string, boolean, objeto timeline, ou null)`,
    '- a chave "_audit" com objeto { "decision": "accept"|"replace"|"reject", "reason": "breve, PT-BR" }',
    `Exemplo de chaves: "${field}" e "_audit".`,
    `Referência de tipo/estrutura: ${jsonExample(field)}`,
  ].join("\n");
}

type AuditResult = {
  ok: boolean;
  value: any;
  raw: string;
  audit: { decision: string; reason: string; source?: string };
};

function parseAuditResponse(field: FieldKey, rawText: string, source?: string): AuditResult {
  const json = safeJsonParse(rawText);
  const audit = json && typeof json === "object" ? (json as any)._audit : null;
  const decision = typeof audit?.decision === "string" ? String(audit.decision).toLowerCase() : "";
  const reason = typeof audit?.reason === "string" ? audit.reason : "";

  let candidate = json && typeof json === "object" ? (json as any)[field] : undefined;
  if (decision === "reject") candidate = null;
  if (candidate === undefined) {
    return {
      ok: false,
      value: null,
      raw: rawText,
      audit: { decision: decision || "unknown", reason: reason || "missing_field_in_json", source },
    };
  }

  const checked = validateFieldValue(field, candidate);
  const ok = json != null && checked.ok;
  return {
    ok,
    value: checked.normalized,
    raw: rawText,
    audit: { decision: decision || (checked.ok ? "accept" : "unknown"), reason, source },
  };
}

function isAuditDecisionFinal(result: AuditResult): boolean {
  if (!result.ok) return false;
  const d = result.audit.decision;
  return d === "accept" || d === "replace" || d === "reject";
}

async function runSingleAuditCall(
  field: FieldKey,
  edital: EditalRow,
  before: any,
  evidence: FieldEvidence | undefined,
  docCtx: string,
  source: string,
): Promise<AuditResult> {
  const prompt = makeAuditPrompt(field, edital, before, evidence);
  const rawText = extractJsonBlock(
    await ollamaGenerate([prompt, "", "DOCUMENTO:", docCtx || "(vazio)"].join("\n")),
  );
  return parseAuditResponse(field, rawText, source);
}

async function callAuditForField(
  field: FieldKey,
  edital: EditalRow,
  before: any,
  evidence: FieldEvidence | undefined,
  rowsRaw: any[],
): Promise<AuditResult> {
  const cap = getMaxAuditContextChars();
  let last: AuditResult = {
    ok: false,
    value: null,
    raw: "",
    audit: { decision: "unknown", reason: "no_audit_attempt" },
  };

  const snippet = evidence?.snippet?.trim();
  if (snippet) {
    const ctx = snippet.length > cap ? snippet.slice(0, cap) : snippet;
    console.log(`  ✓ audit ${field}: trecho evidência ctx_chars=${ctx.length}`);
    try {
      const r = await runSingleAuditCall(field, edital, before, evidence, ctx, "evidence");
      last = r;
      if (isAuditDecisionFinal(r)) return r;
    } catch (e) {
      if (isOllamaTimeout(e)) {
        console.warn(`  ✓ audit ${field}: timeout no trecho de evidência — varredura documento`);
      } else {
        throw e;
      }
    }
  }

  if (!auditChunkScanEnabled()) {
    return last;
  }

  const batches = buildAuditChunkBatches(rowsRaw);
  if (batches.length === 0) return last;

  const cfg = auditBatchConfig();
  console.log(
    `  ✓ audit ${field}: varredura documento lotes=${batches.length} chunks=${rowsRaw.length} (${cfg.chunksPerBatch}/lote)`,
  );

  for (const batch of batches) {
    const bi = batch.batchIndex + 1;
    console.log(
      `  ✓ audit lote ${bi}/${batches.length} campo=${field} chunks=${batch.rows.length} ctx_chars=${batch.text.length}`,
    );
    try {
      const r = await runSingleAuditCall(field, edital, before, evidence, batch.text, "chunkscan");
      last = r;
      if (isAuditDecisionFinal(r)) return r;
    } catch (e) {
      if (isOllamaTimeout(e)) {
        console.warn(`  ✓ audit lote ${bi}/${batches.length}: timeout — próximo lote`);
        continue;
      }
      throw e;
    }
  }

  return last;
}

async function polishFreeTextField(
  field: FieldKey,
  text: string,
  edital: Pick<EditalRow, "numero" | "titulo" | "fonte">,
): Promise<{ text: string; raw: string }> {
  const prompt = [
    "Você melhora a redação do texto abaixo para publicação em portal de editais, com clareza e tom neutro.",
    "Preserve números, datas, valores monetários e nomes próprios exatamente quando forem factuais no texto original.",
    "Não acrescente fatos novos. Se já estiver claro, devolva com ajustes mínimos de gramática e pontuação.",
    "",
    `Edital: ${edital.numero || "N/A"} — ${edital.titulo} (${edital.fonte || "N/A"})`,
    `Campo: ${field}`,
    "",
    "Texto:",
    text,
    "",
    'Responda APENAS JSON válido: {"text":"..."}',
  ].join("\n");

  const rawText = extractJsonBlock(await ollamaGenerate(prompt));
  const json = safeJsonParse(rawText);
  const out = json && typeof json === "object" && typeof (json as any).text === "string" ? String((json as any).text) : "";
  const trimmed = out.replace(/\s+/g, " ").trim();
  if (!trimmed) return { text, raw: rawText };
  return { text: trimmed, raw: rawText };
}

function normalizeTimelineEstimada(value: any): { fases: Array<Record<string, string | null>> } | null {
  let cur = unwrapJsonLayers(value);
  if (typeof cur === "string") {
    const parsed = safeJsonParse(cur);
    cur = parsed ?? cur;
  }
  if (!cur || typeof cur !== "object") return null;

  const rawFases = Array.isArray((cur as any).fases) ? (cur as any).fases : [];
  const fases = rawFases
    .map((f: any) => ({
      nome: normalizeMaybeString(f?.nome),
      prazo: normalizeMaybeString(f?.prazo),
      status: normalizeMaybeString(f?.status),
      data_inicio: normalizeMaybeString(f?.data_inicio),
      data_fim: normalizeMaybeString(f?.data_fim) || normalizeMaybeString(f?.fim),
    }))
    .filter((f) => f.nome || f.prazo || f.status || f.data_inicio || f.data_fim);

  return fases.length > 0 ? { fases } : null;
}

function formatEditalCorretoRow(edital: EditalRow, current: Record<string, any>) {
  const sobrePrograma =
    typeof current.sobre_programa === "string" ? normalizeMaybeString(current.sobre_programa) : current.sobre_programa;
  const descricao = normalizeMaybeString(edital.descricao) || (typeof sobrePrograma === "string" ? sobrePrograma : null);

  return {
    id: edital.id,
    numero: normalizeMaybeString(edital.numero),
    titulo: normalizeMaybeString(edital.titulo) || String(edital.titulo || "").trim(),
    descricao,
    processado_em: edital.processado_em,
    criado_em: edital.criado_em,
    atualizado_em: edital.atualizado_em ?? new Date().toISOString(),
    data_publicacao: edital.data_publicacao,
    data_encerramento: edital.data_encerramento,
    status: normalizeMaybeString(edital.status),
    valor: normalizeMaybeString(edital.valor),
    area: normalizeMaybeString(edital.area),
    orgao: normalizeMaybeString(edital.orgao),
    fonte: normalizeMaybeString(edital.fonte) || edital.fonte,
    link: normalizeMaybeString(edital.link),
    origem_informacoes_processadas_em: edital.informacoes_processadas_em,
    validado_em: new Date().toISOString(),
    valor_projeto: typeof current.valor_projeto === "string" ? normalizeMaybeString(current.valor_projeto) : current.valor_projeto,
    prazo_inscricao: typeof current.prazo_inscricao === "string" ? normalizeMaybeString(current.prazo_inscricao) : current.prazo_inscricao,
    localizacao: typeof current.localizacao === "string" ? normalizeMaybeString(current.localizacao) : current.localizacao,
    vagas: typeof current.vagas === "string" ? normalizeMaybeString(current.vagas) : current.vagas,
    is_researcher: typeof current.is_researcher === "boolean" ? current.is_researcher : null,
    is_company: typeof current.is_company === "boolean" ? current.is_company : null,
    sobre_programa: typeof sobrePrograma === "string" ? sobrePrograma : null,
    criterios_elegibilidade:
      typeof current.criterios_elegibilidade === "string"
        ? normalizeMaybeString(current.criterios_elegibilidade)
        : current.criterios_elegibilidade,
    timeline_estimada: normalizeTimelineEstimada(current.timeline_estimada),
  };
}

function jsonExample(field: FieldKey): string {
  if (field === "timeline_estimada") {
    return `{\"timeline_estimada\":{\"fases\":[{\"nome\":\"Inscrição\",\"prazo\":\"...\",\"status\":\"aberto|fechado|pendente\",\"data_inicio\":\"YYYY-MM-DD\",\"data_fim\":\"YYYY-MM-DD\"}]}} ou {\"timeline_estimada\":null}`;
  }
  if (field === "is_researcher" || field === "is_company") {
    return `{\"${field}\": true} ou {\"${field}\": false} ou {\"${field}\": null}`;
  }
  return `{\"${field}\":\"texto...\"} ou {\"${field}\": null}`;
}

const FIELD_PRESENTATION_GUIDANCE: Record<FieldKey, string> = {
  valor_projeto:
    "Valide e padronize o valor por projeto/bolsa/recursos. Preserve a unidade e a regra (por projeto, por bolsa, total, etc.).",
  prazo_inscricao:
    "Valide e padronize o(s) prazo(s) de inscrição/submissão. Se houver datas e horários, preserve. Se houver múltiplas janelas/etapas, resuma em uma string única clara.",
  localizacao:
    "Valide e padronize a elegibilidade geográfica/alcance (ex: 'Brasil', 'Estado do Ceará', 'Região Nordeste', 'Municípios do ES').",
  vagas:
    "Valide e padronize número de vagas/projetos/bolsas/selecionados. Se houver faixas, descreva (ex: 'até 30 projetos').",
  is_researcher:
    "Valide se o público-alvo inclui pesquisadores/ICTs/universidades como proponentes elegíveis. true/false/null (null se não houver evidência explícita).",
  is_company:
    "Valide se o público-alvo inclui empresas/startups como proponentes elegíveis. true/false/null (null se não houver evidência explícita).",
  sobre_programa:
    "Valide um parágrafo curto e objetivo sobre o programa/objetivo do edital, fiel ao texto (a redação final será refinada numa etapa separada).",
  criterios_elegibilidade:
    "Valide e padronize critérios/requisitos de elegibilidade em texto corrido (ou linhas separadas por \\n) com linguagem fiel ao edital. Não invente.",
  timeline_estimada:
    "Valide se existe cronograma/timeline no edital. Se sim, normalize para o formato do site (fases com datas/prazos quando existirem). Se não houver, retorne null.",
};

function isTimelineEstimadaSiteShapeOk(v: any): boolean {
  if (v === null) return true;
  if (!v || typeof v !== "object") return false;
  const fases = (v as any).fases;
  if (!Array.isArray(fases) || fases.length === 0) return false;
  for (const f of fases) {
    if (!f || typeof f !== "object") return false;
    if (typeof (f as any).nome !== "string" || !(f as any).nome.trim()) return false;
    if ((f as any).prazo != null && typeof (f as any).prazo !== "string") return false;
    if ((f as any).status != null && typeof (f as any).status !== "string") return false;
    if ((f as any).data_inicio != null && typeof (f as any).data_inicio !== "string") return false;
    if ((f as any).data_fim != null && typeof (f as any).data_fim !== "string") return false;
  }
  return true;
}

function canonicalizePrazoInscricaoForSite(v: any): string | null {
  if (v == null) return null;
  const unwrapped = unwrapJsonLayers(v);
  if (unwrapped == null) return null;
  if (typeof unwrapped === "object") {
    try {
      return JSON.stringify(unwrapped);
    } catch {
      return null;
    }
  }
  const raw = normalizeMaybeString(String(unwrapped));
  if (!raw) return null;
  return normalizePrazoInscricaoFromText(raw) ?? raw;
}

function validateFieldValue(field: FieldKey, value: any): { ok: boolean; normalized: any } {
  if (value === undefined) return { ok: false, normalized: undefined };
  if (value === null) return { ok: true, normalized: null };
  const t = fieldType(field);
  if (t === "boolean") return { ok: typeof value === "boolean", normalized: typeof value === "boolean" ? value : null };
  if (t === "json") {
    if (field === "timeline_estimada") {
      const normalized = normalizeTimelineEstimada(value);
      if (!normalized || !isTimelineEstimadaSiteShapeOk(normalized)) return { ok: false, normalized: null };
      return { ok: true, normalized };
    }
    if (typeof value === "object" && value !== null) return { ok: true, normalized: value };
    return { ok: false, normalized: null };
  }
  if (typeof value !== "string") return { ok: false, normalized: null };
  return { ok: true, normalized: normalizeMaybeString(value) };
}

async function updateOriginalEditalField(supabase: SupabaseClient, editalId: string, field: FieldKey, value: any): Promise<void> {
  const patch: any = { [field]: value };
  const { error } = await supabase.from("editais").update(patch).eq("id", editalId);
  if (error) throw new Error(`Erro ao atualizar editais.${field}: ${error.message}`);
}

async function validateOneEdital(
  supabase: SupabaseClient,
  edital: EditalRow,
): Promise<{ inserted: boolean; reasons: string[] }> {
  const current: Record<string, any> = {};
  for (const field of EXTRACTED_FIELDS) {
    current[field] = (edital as any)[field] ?? null;
  }

  const fileIds = await fetchEditalPdfKeys(supabase, edital.id);
  const rowsRaw = await fetchRawDocumentRows(supabase, edital.id, fileIds);
  const chunksTotal = rowsRaw.length;
  const withEmbReport = rowsRaw.filter((r: any) => rowHasAnyEmbeddingRow(r)).length;

  if (rowsRaw.length === 0 || !rowsRaw.some((r: any) => typeof r?.content === "string" && r.content.trim().length > 0)) {
    return { inserted: false, reasons: ["sem_contexto_documents"] };
  }

  const evidenceMap =
    edital.informacoes_extracao_evidence && typeof edital.informacoes_extracao_evidence === "object" && !Array.isArray(edital.informacoes_extracao_evidence)
      ? edital.informacoes_extracao_evidence
      : {};
  const skipPolish = String(process.env.VALIDATE_SKIP_POLISH || "").trim() === "1";

  const reportFields: Record<string, any> = {};
  const fieldConcurrency = readConcurrencyEnv("VALIDATE_FIELD_CONCURRENCY", 1, 4);

  type FieldOutcome = {
    field: FieldKey;
    report: Record<string, unknown>;
    finalValue: any;
    auditedOk: boolean;
    before: any;
    dbUpdate: "null" | "value" | null;
  };

  const runField = async (field: FieldKey): Promise<FieldOutcome> => {
    const before = (edital as any)[field] ?? null;

    if (!fieldNeedsAudit(field, before)) {
      return {
        field,
        report: { status: "skipped", reason: "before_is_null", before, after: before ?? null },
        finalValue: before ?? null,
        auditedOk: true,
        before,
        dbUpdate: null,
      };
    }

    const auditBefore = hasMeaningfulExtractedValue(field, before) ? before : null;
    const evidence = evidenceMap[field] as FieldEvidence | undefined;
    const audited = await callAuditForField(field, edital, auditBefore, evidence, rowsRaw);
    let finalValue = audited.ok ? audited.value : before;

    let polishMeta: { applied: boolean; raw?: string; note?: string } = { applied: false, note: "skipped" };
    if (audited.ok && finalValue != null && fieldType(field) === "string" && !skipPolish) {
      const s = typeof finalValue === "string" ? finalValue : null;
      if (s && s.length > 0) {
        try {
          const polished = await polishFreeTextField(field, s, edital);
          finalValue = polished.text;
          polishMeta = { applied: true, raw: polished.raw };
        } catch (e) {
          if (isOllamaTimeout(e)) {
            console.warn(`  ✓ polish ${field}: timeout — mantém texto auditado`);
            polishMeta = { applied: false, note: "polish_timeout" };
          } else {
            throw e;
          }
        }
      } else {
        polishMeta = { applied: false, note: "empty_string" };
      }
    } else if (audited.ok && finalValue != null && fieldType(field) !== "string") {
      polishMeta = { applied: false, note: "not_string_field" };
    } else if (skipPolish) {
      polishMeta = { applied: false, note: "VALIDATE_SKIP_POLISH=1" };
    }

    let status = "kept";
    if (!audited.ok) status = "inconclusive";
    else if (finalValue === null && before !== null) status = "cleared";
    else if (JSON.stringify(before) !== JSON.stringify(finalValue)) status = "corrected";

    const report = {
      status,
      before: field === "timeline_estimada" ? normalizeTimelineEstimada(before) : before,
      after: field === "timeline_estimada" ? normalizeTimelineEstimada(finalValue) : finalValue,
      audit: { ...audited.audit, raw: audited.raw },
      polish: polishMeta,
      extraction_evidence: evidence
        ? {
            source: evidence.source,
            document_id: evidence.document_id ?? null,
            document_ids: evidence.document_ids ?? (evidence.document_id ? [evidence.document_id] : undefined),
            snippet_preview: String(evidence.snippet || "").slice(0, 400),
          }
        : null,
      ...(!audited.ok ? { note: "auditoria_sem_decisao_final" } : {}),
    };

    if (!audited.ok) {
      return {
        field,
        report,
        finalValue: before,
        auditedOk: true,
        before,
        dbUpdate: null,
      };
    }

    const shouldNull = finalValue === null && before !== null && before !== undefined;
    const changed = finalValue !== null && JSON.stringify(before) !== JSON.stringify(finalValue);
    let dbUpdate: "null" | "value" | null = null;
    if (shouldNull) dbUpdate = "null";
    else if (changed) dbUpdate = "value";

    return { field, report, finalValue, auditedOk: true, before, dbUpdate };
  };

  const fieldOutcomes =
    fieldConcurrency > 1
      ? await mapPool(EXTRACTED_FIELDS, fieldConcurrency, runField)
      : await Promise.all(EXTRACTED_FIELDS.map((field) => runField(field)));

  for (const o of fieldOutcomes) {
    reportFields[o.field] = o.report;
    current[o.field] = o.finalValue;
    if (o.dbUpdate === "null") await updateOriginalEditalField(supabase, edital.id, o.field, null);
    else if (o.dbUpdate === "value") await updateOriginalEditalField(supabase, edital.id, o.field, o.finalValue);
  }

  const prazoBeforeReconcile = current.prazo_inscricao;
  const reconciledPrazo = reconcilePrazoInscricao(
    current.prazo_inscricao,
    current.timeline_estimada,
    edital.data_encerramento,
  );
  if (
    reconciledPrazo &&
    !hasMeaningfulExtractedValue("prazo_inscricao", prazoBeforeReconcile) &&
    reconciledPrazo !== prazoBeforeReconcile
  ) {
    current.prazo_inscricao = reconciledPrazo;
    await updateOriginalEditalField(supabase, edital.id, "prazo_inscricao", reconciledPrazo);
    reportFields.prazo_inscricao = {
      ...(typeof reportFields.prazo_inscricao === "object" && reportFields.prazo_inscricao
        ? reportFields.prazo_inscricao
        : {}),
      status: "derived_from_timeline",
      before: (edital as any).prazo_inscricao ?? null,
      after: reconciledPrazo,
      reason: "timeline_ou_data_encerramento",
    };
  } else if (reconciledPrazo) {
    current.prazo_inscricao = reconciledPrazo;
  }

  current.prazo_inscricao = canonicalizePrazoInscricaoForSite(current.prazo_inscricao);

  const rowToUpsert = formatEditalCorretoRow(edital, current);

  const hasAnyUsefulField = Boolean(
    rowToUpsert.valor_projeto ||
      rowToUpsert.prazo_inscricao ||
      rowToUpsert.sobre_programa ||
      rowToUpsert.criterios_elegibilidade ||
      rowToUpsert.timeline_estimada ||
      rowToUpsert.localizacao ||
      rowToUpsert.vagas ||
      rowToUpsert.is_researcher != null ||
      rowToUpsert.is_company != null,
  );
  if (!hasAnyUsefulField) {
    return { inserted: false, reasons: ["sem_campos_uteis"] };
  }

  const present = assessEditalCorretoPresentable(rowToUpsert);
  if (!present.ok) {
    return { inserted: false, reasons: present.reasons };
  }

  const validationReport = {
    validated_at: rowToUpsert.validado_em,
    extracted_fields: listNonNullExtractedFields(edital),
    context: {
      file_ids: fileIds.length,
      chunks: chunksTotal,
      chunks_with_embedding: withEmbReport,
      audit_ctx_chars_per_call: getMaxAuditContextChars(),
      audit_batches: buildAuditChunkBatches(rowsRaw).length,
      ollama: true,
      pipeline: "audit_evidence_then_chunkscan_then_polish_strings",
    },
    presentable: true,
    fields: reportFields,
  };

  const { error } = await supabase
    .from("editais_corretos")
    .upsert({ ...rowToUpsert, validation_report: validationReport }, { onConflict: "id" });
  if (error) throw new Error(`Erro ao upsert em editais_corretos: ${error.message}`);
  return { inserted: true, reasons: [] };
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

async function loadEditalCorretosIdSet(supabase: SupabaseClient): Promise<Set<string>> {
  const { data, error } = await supabase.from("editais_corretos").select("id");
  if (error) throw new Error(`Erro ao listar editais_corretos: ${error.message}`);
  return new Set((data ?? []).map((r: { id: string }) => String(r.id)));
}

async function logValidateFunnelStats(supabase: SupabaseClient, backlogOnly: boolean): Promise<void> {
  const [{ count: total }, { count: processed }, { count: corretos }] = await Promise.all([
    supabase.from("editais").select("*", { count: "exact", head: true }),
    supabase
      .from("editais")
      .select("*", { count: "exact", head: true })
      .not("informacoes_processadas_em", "is", null),
    supabase.from("editais_corretos").select("*", { count: "exact", head: true }),
  ]);
  const backlog = Math.max(0, (processed ?? 0) - (corretos ?? 0));
  console.log(
    `📊 Funil: editais=${total ?? "?"} processados_info=${processed ?? "?"} editais_corretos=${corretos ?? "?"} backlog_validate≈${backlogOnly ? backlog : "n/a"} (modo backlog=${backlogOnly ? "sim" : "não"})`,
  );
}

export async function runValidateBatch(): Promise<{ hadWork: boolean }> {
  await initOllamaBaseUrl();
  const supabase = createSupabase();

  const limitRaw = parseInt(process.env.VALIDATE_EDITAIS_LIMIT || "0", 10);
  const totalLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity;
  const batchSize = Math.max(20, parseInt(process.env.VALIDATE_EDITAIS_BATCH || "200", 10) || 200);
  const editalConcurrency = readConcurrencyEnv("VALIDATE_EDITAL_CONCURRENCY", 2, 6);
  const reprocessValidated = String(process.env.VALIDATE_REPROCESS || "").trim() === "1";
  const backlogOnly = reprocessValidated
    ? String(process.env.VALIDATE_BACKLOG_ONLY || "").trim() === "1"
    : String(process.env.VALIDATE_BACKLOG_ONLY || "1").trim() !== "0";
  const delayDefault = editalConcurrency > 1 ? "0" : "3000";
  const betweenDefault = editalConcurrency > 1 ? "0" : "6000";
  const delayMs = Math.max(0, parseInt(process.env.API_REQUEST_DELAY_MS || delayDefault, 10) || 0);
  const betweenEditaisMs = Math.max(
    0,
    parseInt(process.env.DELAY_BETWEEN_EDITAIS_MS || betweenDefault, 10) || 0,
  );

  const corretosIds = reprocessValidated ? new Set<string>() : await loadEditalCorretosIdSet(supabase);
  await logValidateFunnelStats(supabase, backlogOnly);

  console.log("🔎 validate-edital-service (Ollama-only)");
  console.log(
    `📦 limit=${Number.isFinite(totalLimit) ? totalLimit : "∞"} batch=${batchSize} editalConcurrency=${editalConcurrency} fieldConcurrency=${readConcurrencyEnv("VALIDATE_FIELD_CONCURRENCY", 1, 4)} delayMs=${delayMs} betweenEditaisMs=${betweenEditaisMs} backlogOnly=${backlogOnly} reprocess=${reprocessValidated}`,
  );

  let ok = 0;
  let fail = 0;
  let skipped = 0;
  let seen = 0;
  let hadPotentialWork = false;

  const selectCols =
    "id,numero,titulo,descricao,processado_em,criado_em,atualizado_em,data_publicacao,data_encerramento,status,valor,area,orgao,fonte,link,informacoes_processadas_em,informacoes_extracao_evidence,valor_projeto,prazo_inscricao,localizacao,vagas,is_researcher,is_company,sobre_programa,criterios_elegibilidade,timeline_estimada";

  for (let offset = 0; seen < totalLimit; offset += batchSize) {
    const remainingQuota = Number.isFinite(totalLimit) ? Math.max(0, totalLimit - seen) : batchSize;
    const pageLimit = Math.min(batchSize, remainingQuota || batchSize);

    const { data: pageData, error } = await supabase
      .from("editais")
      .select(selectCols)
      .not("informacoes_processadas_em", "is", null)
      .order("informacoes_processadas_em", { ascending: false })
      .range(offset, offset + pageLimit - 1);
    if (error) throw new Error(`Erro ao buscar editais: ${error.message}`);

    const page = ((pageData ?? []) as EditalRow[]).filter(
      (row) =>
        (reprocessValidated || !corretosIds.has(row.id)) && listNonNullExtractedFields(row).length > 0,
    );
    if (page.length === 0) {
      if ((pageData ?? []).length > 0) continue;
      break;
    }
    hadPotentialWork = true;

    const toRun = Number.isFinite(totalLimit)
      ? page.slice(0, Math.min(page.length, remainingQuota))
      : page;
    seen += toRun.length;

    const processEdital = async (edital: EditalRow) => {
      const nonNullFields = listNonNullExtractedFields(edital);
      const fieldsLabel = nonNullFields.length ? nonNullFields.join(", ") : "nenhum";
      console.log(`\n🧾 ${edital.numero || "N/A"} — ${edital.titulo} (${edital.fonte}) [campos=${fieldsLabel}]`);
      if (nonNullFields.length === 0) {
        skipped++;
        console.log("  ⚠️ Pulado: sem_campos_extraidos_em_editais (correr process-edital antes ou ignorar)");
        return;
      }
      try {
        const r = await validateOneEdital(supabase, edital);
        if (r.inserted) {
          ok++;
          console.log("  ✅ Salvo em editais_corretos");
        } else {
          skipped++;
          const why = r.reasons.length ? r.reasons.join(", ") : "nada para salvar";
          console.log(`  ⚠️ Pulado: ${why}`);
        }
      } catch (e) {
        fail++;
        console.error("  ❌ Falhou:", e instanceof Error ? e.message : String(e));
      }
    };

    if (editalConcurrency > 1 && toRun.length > 1) {
      const chunkSize = editalConcurrency;
      for (let start = 0; start < toRun.length; start += chunkSize) {
        const chunk = toRun.slice(start, start + chunkSize);
        await Promise.all(chunk.map((edital) => processEdital(edital)));
        if (betweenEditaisMs > 0 && start + chunkSize < toRun.length) {
          await new Promise((r) => setTimeout(r, betweenEditaisMs));
        }
      }
    } else {
      for (const edital of toRun) {
        await processEdital(edital);
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
        if (betweenEditaisMs > 0) await new Promise((r) => setTimeout(r, betweenEditaisMs));
      }
    }
  }

  console.log(`\n✅ Concluído. Sucesso: ${ok} | Pulados: ${skipped} | Falhas: ${fail}`);
  if (fail > 0 && !ecsWorkerLoopEnabled()) process.exitCode = 1;
  return { hadWork: hadPotentialWork };
}

async function main() {
  if (ecsWorkerLoopEnabled()) {
    let iter = 0;
    console.log(
      `🔄 ECS_WORKER_LOOP=1 — validate-edital em ciclo contínuo. Idle após lote com linhas=${workerIdleMsAfterWork()}ms; sem fila=${workerIdleMsNoWork()}ms`,
    );
    while (true) {
      iter += 1;
      console.log(`\n🔄 worker iter=${iter} @ ${new Date().toISOString()}`);
      try {
        const { hadWork } = await runValidateBatch();
        const idle = hadWork ? workerIdleMsAfterWork() : workerIdleMsNoWork();
        if (idle > 0) await new Promise((r) => setTimeout(r, idle));
      } catch (e) {
        console.error("❌ worker iter:", e);
        await new Promise((r) => setTimeout(r, workerIdleMsNoWork()));
      }
    }
  }

  await runValidateBatch();
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

