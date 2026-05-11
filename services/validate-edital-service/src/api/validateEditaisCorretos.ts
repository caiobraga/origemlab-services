import "../load-env";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabase } from "../lib/supabase";
import { getMaxContextChars, ollamaGenerate } from "../lib/ollama";

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

function hasParseableSubmissionDeadline(row: {
  data_encerramento?: string | null;
  prazo_inscricao?: string | null;
  timeline_estimada?: any;
}): boolean {
  if (dateFromEncerramento(row.data_encerramento)) return true;
  const prazo = row.prazo_inscricao;
  if (prazo && hasAnyDateSignalInText(typeof prazo === "string" ? prazo : JSON.stringify(prazo))) return true;
  const tl = unwrapJsonLayers(row.timeline_estimada);
  if (tl && typeof tl === "object" && Array.isArray((tl as any).fases)) {
    for (const f of (tl as any).fases) {
      if (!f || typeof f !== "object") continue;
      const bits = [f.data_fim, f.data_inicio, f.prazo, f.fim].filter(Boolean).map(String);
      if (bits.some((b) => hasAnyDateSignalInText(b))) return true;
    }
  }
  return false;
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

  if (!hasParseableSubmissionDeadline(row)) reasons.push("sem_prazo_parseavel");

  return { ok: reasons.length === 0, reasons };
}

async function fetchEditalPdfKeys(supabase: SupabaseClient, editalId: string): Promise<string[]> {
  const { data, error } = await supabase.from("edital_pdfs").select("file_id, id").eq("edital_id", editalId);
  if (error) throw new Error(`Erro ao buscar edital_pdfs: ${error.message}`);
  const keys = (data ?? []).map((r: any) => String(r.file_id || r.id || "").trim()).filter(Boolean);
  return [...new Set(keys)];
}

function asEmbedding(v: any): number[] | null {
  if (!v) return null;
  if (Array.isArray(v) && v.length > 0) return v.map((x) => Number(x));
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

function sortDocumentRows(rows: any[]): any[] {
  return [...rows].sort((a: any, b: any) => {
    const ia = typeof a?.metadata?.chunk_index === "number" ? a.metadata.chunk_index : -1;
    const ib = typeof b?.metadata?.chunk_index === "number" ? b.metadata.chunk_index : -1;
    if (ia !== ib) return ia - ib;
    return String(a.id).localeCompare(String(b.id));
  });
}

function joinDocumentRows(rows: any[]): string {
  return rows
    .map((r: any) => {
      const fid = String(r.file_id || r.id).slice(0, 12);
      const ci = typeof r?.metadata?.chunk_index === "number" ? r.metadata.chunk_index : "?";
      return `--- Documento ${fid} / chunk ${ci} ---\n${String(r.content).trim()}`;
    })
    .join("\n\n");
}

function hasNonEmptyContextText(s: string): boolean {
  return Boolean(String(s || "").trim());
}

async function fetchDocumentsContext(
  supabase: SupabaseClient,
  editalId: string,
  fileIds: string[],
): Promise<{ text: string; chunks: number; withEmbedding: number }> {
  const chunkLimit = Math.max(50, parseInt(process.env.VALIDATE_DOCUMENTS_LIMIT || "400", 10) || 400);
  let rows: any[] = [];

  if (fileIds.length > 0) {
    const { data, error } = await supabase
      .from("documents")
      .select("id,file_id,content,metadata,embedding")
      .in("file_id", fileIds)
      .limit(chunkLimit);
    if (error) throw new Error(`Erro ao buscar documents: ${error.message}`);
    rows = (data ?? []).filter((r: any) => typeof r?.content === "string" && r.content.trim().length > 0);
  }

  if (rows.length === 0) {
    const { data, error } = await supabase
      .from("documents")
      .select("id,file_id,content,metadata,embedding")
      .eq("metadata->>edital_id", String(editalId))
      .limit(chunkLimit);
    if (error) throw new Error(`Erro ao buscar documents: ${error.message}`);
    rows = (data ?? []).filter((r: any) => typeof r?.content === "string" && r.content.trim().length > 0);
  }

  const withEmbedding = rows.filter((r: any) => asEmbedding(r.embedding) != null);
  const selected = withEmbedding.length > 0 ? withEmbedding : rows;
  const joined = joinDocumentRows(sortDocumentRows(selected));
  const maxChars = getMaxContextChars();
  const text = joined.length > maxChars ? joined.slice(0, maxChars) : joined;
  return { text, chunks: selected.length, withEmbedding: withEmbedding.length };
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
      data_fim: normalizeMaybeString(f?.data_fim),
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
    "Valide e melhore um parágrafo curto e objetivo sobre o programa/objetivo do edital, fiel ao texto.",
  criterios_elegibilidade:
    "Valide e padronize critérios/requisitos de elegibilidade em texto corrido (ou linhas separadas por \\n) com linguagem fiel ao edital. Não invente.",
  timeline_estimada:
    "Valide se existe cronograma/timeline no edital. Se sim, normalize para o formato do site (fases com datas/prazos quando existirem). Se não houver, retorne null.",
};

function makeValidateAndImproveCurrentPrompt(field: FieldKey, edital: EditalRow, currentValue: any): string {
  const currentText = currentValue == null ? "null" : JSON.stringify(currentValue);
  return [
    "Você é um auditor/normalizador de dados de editais.",
    "Use SOMENTE o conteúdo dos documentos anexados.",
    "Objetivo: validar se o VALOR ATUAL (do banco) tem evidência explícita no edital. Se tiver, melhore/padronize sem mudar o significado. Se não tiver evidência (ou estiver contraditório), retorne null.",
    "Não extraia campos novos nem responda perguntas de extração; trabalhe apenas com o valor atual.",
    "",
    `Edital: ${edital.numero || "N/A"} — ${edital.titulo}`,
    `Fonte: ${edital.fonte}`,
    "",
    `Campo: ${field}`,
    `Valor atual (banco): ${currentText}`,
    FIELD_PRESENTATION_GUIDANCE[field],
    "",
    "Formato de saída obrigatório: APENAS JSON válido.",
    `Exemplo: ${jsonExample(field)}`,
  ].join("\n");
}

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
  return normalizeMaybeString(String(unwrapped));
}

function validateFieldValue(field: FieldKey, value: any): { ok: boolean; normalized: any } {
  if (value === undefined) return { ok: false, normalized: undefined };
  if (value === null) return { ok: true, normalized: null };
  const t = fieldType(field);
  if (t === "boolean") return { ok: typeof value === "boolean", normalized: typeof value === "boolean" ? value : null };
  if (t === "json") {
    if (field === "timeline_estimada") {
      if (!isTimelineEstimadaSiteShapeOk(value)) return { ok: false, normalized: null };
      return { ok: true, normalized: value };
    }
    if (typeof value === "object" && value !== null) return { ok: true, normalized: value };
    return { ok: false, normalized: null };
  }
  if (typeof value !== "string") return { ok: false, normalized: null };
  return { ok: true, normalized: normalizeMaybeString(value) };
}

async function callJsonForField(field: FieldKey, prompt: string, ctx: string): Promise<{ ok: boolean; value: any; raw: string }> {
  const rawText = extractJsonBlock(await ollamaGenerate([prompt, "", "CONTEÚDO:", ctx || "(vazio)"].join("\n")));
  const json = safeJsonParse(rawText);
  const value = json && typeof json === "object" ? (json as any)[field] : undefined;
  const checked = validateFieldValue(field, value);
  return { ok: json != null && value !== undefined && checked.ok, value: checked.normalized, raw: rawText };
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
  const ctxInfo = await fetchDocumentsContext(supabase, edital.id, fileIds);
  const ctx = ctxInfo.text;

  if (!hasNonEmptyContextText(ctx) || ctxInfo.chunks === 0) {
    return { inserted: false, reasons: ["sem_contexto_documents"] };
  }

  const reportFields: Record<string, any> = {};

  for (const field of EXTRACTED_FIELDS) {
    const before = (edital as any)[field] ?? null;

    if (!hasMeaningfulExtractedValue(field, before)) {
      reportFields[field] = { status: "skipped", reason: "before_is_null", before, after: null };
      current[field] = null;
      continue;
    }

    const prompt = makeValidateAndImproveCurrentPrompt(field, edital, before);
    const validated = await callJsonForField(field, prompt, ctx);
    const finalValue = validated.ok ? validated.value : null;

    let status = "kept";
    if (!validated.ok) status = "invalid";
    else if (finalValue === null && before !== null) status = "cleared";
    else if (JSON.stringify(before) !== JSON.stringify(finalValue)) status = "corrected";

    reportFields[field] = {
      status,
      before: field === "timeline_estimada" ? normalizeTimelineEstimada(before) : before,
      after: field === "timeline_estimada" ? normalizeTimelineEstimada(finalValue) : finalValue,
    };

    if (!validated.ok) continue;

    current[field] = finalValue;
    const shouldNull = finalValue === null && before !== null && before !== undefined;
    const changed = finalValue !== null && JSON.stringify(before) !== JSON.stringify(finalValue);
    if (shouldNull) await updateOriginalEditalField(supabase, edital.id, field, null);
    else if (changed) await updateOriginalEditalField(supabase, edital.id, field, finalValue);
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
      chunks: ctxInfo.chunks,
      chunks_with_embedding: ctxInfo.withEmbedding,
      ctx_chars: ctx.length,
      ollama: true,
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

async function main() {
  const supabase = createSupabase();

  const limitRaw = parseInt(process.env.VALIDATE_EDITAIS_LIMIT || "0", 10);
  const totalLimit = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : Infinity;
  const batchSize = Math.max(20, parseInt(process.env.VALIDATE_EDITAIS_BATCH || "200", 10) || 200);
  const delayMs = parseInt(process.env.API_REQUEST_DELAY_MS || "3000", 10);
  const betweenEditaisMs = parseInt(process.env.DELAY_BETWEEN_EDITAIS_MS || "6000", 10);

  console.log("🔎 validate-edital-service (Ollama-only)");
  console.log(`📦 limit=${Number.isFinite(totalLimit) ? totalLimit : "∞"} batch=${batchSize} scope=todos_processados`);

  let ok = 0;
  let fail = 0;
  let skipped = 0;
  let seen = 0;

  const selectCols =
    "id,numero,titulo,descricao,processado_em,criado_em,atualizado_em,data_publicacao,data_encerramento,status,valor,area,orgao,fonte,link,informacoes_processadas_em,valor_projeto,prazo_inscricao,localizacao,vagas,is_researcher,is_company,sobre_programa,criterios_elegibilidade,timeline_estimada";

  for (let offset = 0; seen < totalLimit; offset += batchSize) {
    const remaining = Number.isFinite(totalLimit) ? Math.max(0, totalLimit - seen) : batchSize;
    const pageLimit = Math.min(batchSize, remaining || batchSize);

    const { data: pageData, error } = await supabase
      .from("editais")
      .select(selectCols)
      .not("informacoes_processadas_em", "is", null)
      .order("informacoes_processadas_em", { ascending: false })
      .range(offset, offset + pageLimit - 1);
    if (error) throw new Error(`Erro ao buscar editais: ${error.message}`);

    const page = (pageData ?? []) as EditalRow[];
    if (page.length === 0) break;

    for (const edital of page) {
      if (seen >= totalLimit) break;
      seen++;

      const nonNullFields = listNonNullExtractedFields(edital);
      const fieldsLabel = nonNullFields.length ? nonNullFields.join(", ") : "nenhum";
      console.log(`\n🧾 ${edital.numero || "N/A"} — ${edital.titulo} (${edital.fonte}) [campos=${fieldsLabel}]`);
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

      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      if (betweenEditaisMs > 0) await new Promise((r) => setTimeout(r, betweenEditaisMs));
    }
  }

  console.log(`\n✅ Concluído. Sucesso: ${ok} | Pulados: ${skipped} | Falhas: ${fail}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error("❌ fatal:", e);
  process.exitCode = 1;
});

