#!/usr/bin/env node
/**
 * PDF → texto → chunks → (opcional) enriquecimento LLM alinhado ao process-edital-info → documents.
 * Grava `embedding` (texto completo do chunk) e `embedding_perguntas` (só cabeçalho até “Perguntas exemplo” — top-k no process-edital).
 * Retrospetivo: `npm run start -- --backfill-embedding-perguntas` (após sql/20260513_documents_embedding_perguntas.sql).
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OLLAMA_BASE_URL, OLLAMA_CHAT_MODEL, OLLAMA_EMBED_MODEL,
 *      CHUNK_SIZE, CHUNK_OVERLAP, ENRICH_CHUNKS=1|0, CHUNK_ENRICH_DELAY_MS, DISABLE_EVENTBRIDGE,
 *      DOCUMENT_PROCESSOR_EMBED_PERGUNTAS=1|0 (segunda coluna de embedding; default 1)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./loadEnv.mjs";
import { initOllamaBaseUrl } from "./ollamaResolve.mjs";
import {
  enrichChunkForRetrieval,
  enrichConcurrency,
  enrichMaxChunksPerPdf,
  retrievalEmbeddingInputFromChunkContent,
} from "./enrichChunk.mjs";
import { mapWithConcurrency } from "./concurrency.mjs";
import { embedWithOllamaBatched } from "./embed.mjs";
import {
  chunkText,
  extractTextFromPdf,
  fetchPdfBuffer,
  getSupabase,
  sanitizeChunkContent,
} from "./pdfPipeline.mjs";
import { publishDomainEvent, makeEventBase } from "./eventbridge.mjs";

loadEnv();

const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || "800", 10);
const CHUNK_OVERLAP = parseInt(process.env.CHUNK_OVERLAP || "200", 10);

function parseArgs(argv) {
  const args = { dryRun: false, processAll: false, rebuild: false, limit: null, backfillEmbeddingPerguntas: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    if (a === "--all") args.processAll = true;
    if (a === "--rebuild") args.rebuild = true;
    if (a === "--backfill-embedding-perguntas") args.backfillEmbeddingPerguntas = true;
    if (a === "--limit" && argv[i + 1]) args.limit = parseInt(argv[++i], 10);
    if (a.startsWith("--limit=")) args.limit = parseInt(a.split("=")[1], 10);
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function msSince(t0) {
  return Date.now() - t0;
}

function minutes(n, fallback) {
  const v = parseInt(String(n ?? ""), 10);
  return Number.isFinite(v) ? v : fallback;
}

async function cleanupOldNullEmbeddings(supabase) {
  const enabledRaw = String(process.env.CLEANUP_NULL_EMBEDDINGS_ON_START || "1").trim().toLowerCase();
  const enabled = enabledRaw !== "0" && enabledRaw !== "false" && enabledRaw !== "no";
  if (!enabled) return;

  const olderThanMin = Math.max(5, minutes(process.env.CLEANUP_NULL_EMBEDDINGS_OLDER_THAN_MINUTES, 120));
  const cutoff = new Date(Date.now() - olderThanMin * 60_000).toISOString();

  const t0 = Date.now();
  try {
    // "Safe" cleanup: only delete old partial rows.
    // Requires `criado_em` (preferred) or `created_at` to exist; otherwise skip.
    const attempt = async (col) =>
      await withRetry(
        () =>
          supabase
            .from("documents")
            .delete()
            .is("embedding", null)
            .lt(col, cutoff),
        { label: `cleanup old NULL embeddings (${col})` },
      );

    const r1 = await attempt("criado_em");
    if (r1?.error) {
      const msg1 = String(r1.error.message || "");
      const missing1 = /criado_em/i.test(msg1) && /column/i.test(msg1) && /does not exist/i.test(msg1);
      if (!missing1) {
        console.warn(`   ⚠️ cleanup warn (criado_em):`, msg1);
        return;
      }
      const r2 = await attempt("created_at");
      if (r2?.error) {
        const msg2 = String(r2.error.message || "");
        const missing2 = /created_at/i.test(msg2) && /column/i.test(msg2) && /does not exist/i.test(msg2);
        if (missing2) {
          console.warn(
            `   ⚠️ cleanup skip: colunas criado_em/created_at não existem em documents (não dá pra fazer limpeza segura por idade)`,
          );
          return;
        }
        console.warn(`   ⚠️ cleanup warn (created_at):`, msg2);
        return;
      }
      console.log(`   🧹 cleanup: removidos documents embedding NULL com created_at < ${cutoff} (t=${msSince(t0)}ms)`);
      return;
    }
    console.log(`   🧹 cleanup: removidos documents embedding NULL com criado_em < ${cutoff} (t=${msSince(t0)}ms)`);
  } catch (e) {
    console.warn(`   ⚠️ cleanup warn:`, e instanceof Error ? e.message : e);
  }
}

async function withRetry(fn, { retries = 4, baseDelayMs = 250, label = "op" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      const retryable =
        /ECONNRESET|fetch failed|terminated|socket|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|503|429/i.test(msg) ||
        (e && typeof e === "object" && ("cause" in e) ? /ECONNRESET/i.test(String(e.cause)) : false);
      if (!retryable || attempt >= retries) break;
      const delay = Math.round(baseDelayMs * Math.pow(2, attempt) + Math.random() * 150);
      console.warn(`   ⚠️ ${label} falhou (tentativa ${attempt + 1}/${retries + 1}): ${msg} — retry em ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function fetchExistingDocumentsForFile(supabase, fileId) {
  const fid = String(fileId);
  const { data, error } = await withRetry(
    () =>
      supabase
        .from("documents")
        .select("id, content, embedding, embedding_perguntas, metadata")
        .eq("file_id", fid)
        .order("id", { ascending: true }),
    { label: "fetch documents" },
  );
  if (error) throw error;
  return data || [];
}

async function countMissingEmbeddings(supabase, fileId) {
  const fid = String(fileId);
  const { data, error } = await withRetry(
    () => supabase.from("documents").select("id, embedding, embedding_perguntas").eq("file_id", fid),
    { label: "check embeddings" },
  );
  if (error) throw error;
  const rows = data || [];
  const missing = rows.filter((r) => !r.embedding || (Array.isArray(r.embedding) && r.embedding.length === 0)).length;
  return { total: rows.length, missing };
}

function embedPerguntasColumnEnabled() {
  const v = String(process.env.DOCUMENT_PROCESSOR_EMBED_PERGUNTAS ?? "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "no";
}

/**
 * Preenche `embedding_perguntas` para linhas que já têm `embedding` (retrospetivo).
 * @returns {Promise<number>} número de linhas atualizadas
 */
async function backfillEmbeddingPerguntas(supabase, { limit } = {}) {
  const batchSize = Math.min(96, Math.max(8, parseInt(process.env.BACKFILL_PERGUNTAS_EMBED_BATCH || "24", 10)));
  let processed = 0;
  console.log(
    `[document-processor] --backfill-embedding-perguntas (batch=${batchSize}${limit != null && limit > 0 ? `, limit=${limit}` : ""})`,
  );
  for (;;) {
    if (limit != null && limit > 0 && processed >= limit) break;
    const take = limit != null && limit > 0 ? Math.min(batchSize, limit - processed) : batchSize;
    const { data, error } = await withRetry(
      () =>
        supabase
          .from("documents")
          .select("id, content")
          .not("embedding", "is", null)
          .is("embedding_perguntas", null)
          .limit(take),
      { label: "backfill fetch documents" },
    );
    if (error) throw error;
    const rows = data || [];
    if (rows.length === 0) {
      console.log(`[document-processor] backfill concluído: total atualizados=${processed}`);
      return processed;
    }
    const texts = rows.map((r) => retrievalEmbeddingInputFromChunkContent(r.content));
    const embeddings = await withRetry(() => embedWithOllamaBatched(texts), { label: "backfill ollama embed" });
    if (!Array.isArray(embeddings) || embeddings.length !== rows.length) {
      throw new Error(`backfill: embeddings ${embeddings?.length} !== rows ${rows.length}`);
    }
    for (let i = 0; i < rows.length; i++) {
      const emb = embeddings[i];
      if (!emb?.length) continue;
      const { error: upErr } = await withRetry(
        () => supabase.from("documents").update({ embedding_perguntas: emb }).eq("id", rows[i].id),
        { label: "backfill update doc" },
      );
      if (upErr) throw upErr;
      processed++;
    }
    console.log(`   backfill +${rows.length} (acumulado=${processed})`);
  }
  return processed;
}

const PDF_SELECT = "id, file_id, edital_id, caminho_storage, is_processed";

function pdfFileKey(pdf) {
  return String(pdf.file_id || pdf.id || "").trim();
}

async function isPdfFullyIndexed(supabase, fileId) {
  const { total, missing } = await countMissingEmbeddings(supabase, fileId);
  return total > 0 && missing === 0;
}

async function markPdfProcessingState(supabase, pdf, processed) {
  if (pdf.file_id) {
    const fid = String(pdf.file_id);
    const { error } = await withRetry(
      () => supabase.from("edital_pdfs").update({ is_processed: processed }).eq("file_id", fid),
      { label: `update is_processed=${processed} (by file_id)` },
    );
    if (error) throw error;
    return;
  }
  const { error } = await withRetry(
    () => supabase.from("edital_pdfs").update({ is_processed: processed }).eq("id", pdf.id),
    { label: `update is_processed=${processed} (by id)` },
  );
  if (error) throw error;
}

function dedupePdfs(list) {
  const seen = new Set();
  const deduped = [];
  for (const p of list) {
    const fid = pdfFileKey(p);
    if (!fid) continue;
    if (seen.has(fid)) continue;
    seen.add(fid);
    deduped.push(p);
  }
  return deduped;
}

async function loadProcessingQueue(supabase, { processAll, limit }) {
  if (processAll) {
    const { data, error } = await supabase
      .from("edital_pdfs")
      .select(PDF_SELECT)
      .order("edital_id", { ascending: true });
    if (error) throw error;
    const deduped = dedupePdfs(data || []);
    return limit != null && limit > 0 ? deduped.slice(0, limit) : deduped;
  }

  let list = [];
  const { data: pdfs, error: pdfsErr } = await supabase
    .from("edital_pdfs")
    .select(PDF_SELECT)
    .or("is_processed.is.null,is_processed.eq.false")
    .order("edital_id", { ascending: true });

  if (pdfsErr) {
    if (pdfsErr.message?.includes("is_processed")) {
      console.warn("   ⚠️ Coluna is_processed ausente; buscando todos os PDFs.");
      const { data: allPdfs, error: e2 } = await supabase
        .from("edital_pdfs")
        .select("id, file_id, edital_id, caminho_storage")
        .order("edital_id", { ascending: true });
      if (e2) throw e2;
      list = allPdfs || [];
    } else {
      throw pdfsErr;
    }
  } else {
    list = pdfs || [];
  }

  let deduped = dedupePdfs(list);
  if (deduped.length === 0) {
    const reverify = String(process.env.DOCUMENT_PROCESSOR_REVERIFY_PROCESSED ?? "1").trim() !== "0";
    if (reverify) {
      console.log("   🔁 Fila pendente vazia; verificando PDFs marcados como processados sem índice completo...");
      const { data: marked, error: markErr } = await supabase
        .from("edital_pdfs")
        .select(PDF_SELECT)
        .eq("is_processed", true)
        .order("edital_id", { ascending: true })
        .limit(5000);
      if (markErr) throw markErr;

      const stale = [];
      const seen = new Set();
      for (const p of marked || []) {
        const fid = pdfFileKey(p);
        if (!fid || seen.has(fid)) continue;
        seen.add(fid);
        if (!(await isPdfFullyIndexed(supabase, fid))) stale.push(p);
      }
      if (stale.length > 0) {
        console.log(`   📌 Reenfileirados ${stale.length} PDF(s) sem chunks/embeddings completos`);
        deduped = dedupePdfs(stale);
      }
    }
  }

  return limit != null && limit > 0 ? deduped.slice(0, limit) : deduped;
}

function ecsWorkerLoopEnabled() {
  const v = String(process.env.ECS_WORKER_LOOP || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function workerIdleMsAfterWork() {
  const n = parseInt(process.env.WORKER_IDLE_MS_AFTER_WORK || "8000", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 8000;
}

function workerIdleMsNoWork() {
  const n = parseInt(process.env.WORKER_IDLE_MS_NO_WORK || "120000", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 120000;
}

/**
 * Um ciclo de fila (pendentes + opcional --all/--rebuild via argv).
 * @returns {{ queueLength: number }}
 */
export async function runDocumentProcessor(cliArgs = process.argv.slice(2)) {
  const { dryRun, processAll, rebuild, limit, backfillEmbeddingPerguntas: runBackfillEmbeddingPerguntas } =
    parseArgs(cliArgs);
  const startedAt = Date.now();
  const supabase = getSupabase();

  if (runBackfillEmbeddingPerguntas) {
    const n = await backfillEmbeddingPerguntas(supabase, { limit });
    console.log(`\n[document-processor] backfill embedding_perguntas: ${n} documento(s) atualizado(s).`);
    return { queueLength: 0 };
  }

  await initOllamaBaseUrl();

  console.log("[document-processor] PDF → chunks → enrich (process-edital context) → embed → documents");
  const enrichOn = !["0", "false"].includes(String(process.env.ENRICH_CHUNKS ?? "1").trim().toLowerCase());
  const enrichPar = enrichOn ? enrichConcurrency() : 0;
  const enrichCap = enrichOn ? enrichMaxChunksPerPdf() : 0;
  console.log(
    `   chunk size=${CHUNK_SIZE} overlap=${CHUNK_OVERLAP} enrich=${enrichOn ? 1 : 0}${enrichOn ? ` concurrency=${enrichPar}` : ""}${enrichCap > 0 ? ` max_chunks=${enrichCap}` : ""}`,
  );
  console.log(
    `   ollama=${process.env.OLLAMA_BASE_URL} chat=${process.env.OLLAMA_CHAT_MODEL || "—"} embed=${process.env.OLLAMA_EMBED_MODEL || "mxbai-embed-large"}`,
  );
  if (dryRun) console.log("   mode: --dry-run");
  if (rebuild) console.log("   mode: --rebuild (força recriar chunks)");

  await cleanupOldNullEmbeddings(supabase);

  const toProcess = await loadProcessingQueue(supabase, { processAll, limit });
  console.log(`   PDFs na fila: ${toProcess.length}`);
  if (enrichOn && toProcess.length > 20) {
    const estChunks = 30;
    const estMin = Math.round((toProcess.length * estChunks * (enrichOn ? 8 / enrichPar : 0.5)) / 60);
    console.log(
      `   ⏱️ enrich=1 ≈ ${estMin}+ min nesta fila (depende do modelo/Ollama). Rápido: ENRICH_CHUNKS=0 | paralelo: ENRICH_CONCURRENCY=6 | modelo: qwen2.5:3b-instruct`,
    );
  }
  if (toProcess.length === 0) {
    console.log(
      "   Nenhum PDF pendente. Use `npm run start -- --all` para reprocessar tudo ou confira OLLAMA_BASE_URL/embeddings.",
    );
  }
  console.log("");

  const editalIds = [...new Set(toProcess.map((p) => p.edital_id).filter(Boolean))];
  const editalPrefixMap = new Map();
  if (editalIds.length > 0) {
    const { data: editais } = await supabase.from("editais").select("id, fonte, numero").in("id", editalIds);
    const sanitize = (s) =>
      String(s ?? "unknown")
        .replace(/[^a-zA-Z0-9._-]/g, "_")
        .replace(/_{2,}/g, "_")
        .replace(/^_+|_+$/g, "")
        .substring(0, 100);
    for (const e of editais || []) {
      editalPrefixMap.set(e.id, { fonte: sanitize(e.fonte), numero: sanitize(e.numero) });
    }
  }

  let totalChunks = 0;
  let totalOk = 0;
  let totalFail = 0;

  async function processOne(pdf, i) {
    const fileId = pdf.file_id || pdf.id;
    const storagePath = pdf.caminho_storage;
    const editalPrefix = pdf.edital_id ? editalPrefixMap.get(pdf.edital_id) ?? null : null;
    let chunksDelta = 0;
    let okDelta = 0;
    let failDelta = 0;

    if (dryRun) {
      console.log(`   [${i + 1}/${toProcess.length}] file_id=${fileId} (dry-run)`);
      return { chunksDelta, okDelta, failDelta };
    }

    const pdfT0 = Date.now();
    console.log(`\n   ▶️ [${i + 1}/${toProcess.length}] start file_id=${fileId} edital_id=${pdf.edital_id ?? "—"}`);

    // Limpeza: remove chunks parciais (sem embedding) antes de decidir reuso.
    // Embeddings estão no campo `embedding` (pgvector); rows sem embedding = embedding NULL.
    await withRetry(() => supabase.from("documents").delete().eq("file_id", String(fileId)).is("embedding", null), {
      label: "cleanup docs w/ NULL embedding",
    });

    let existingDocs = [];
    try {
      existingDocs = await fetchExistingDocumentsForFile(supabase, fileId);
    } catch (e) {
      console.warn(`   ⚠️ Não consegui consultar documents existentes para ${fileId}:`, e instanceof Error ? e.message : e);
      existingDocs = [];
    }

    if (!processAll && !rebuild && (await isPdfFullyIndexed(supabase, fileId))) {
      if (pdf.is_processed !== true) {
        await markPdfProcessingState(supabase, pdf, true);
      }
      console.log(`      ⏩ índice completo; pulando (t=${msSince(pdfT0)}ms)`);
      return { chunksDelta, okDelta, failDelta };
    }

    const editalIdSafe = pdf.edital_id != null ? String(pdf.edital_id) : null;
    let rows = [];

    const shouldReuseExisting = !rebuild && existingDocs.length > 0;
    if (shouldReuseExisting) {
      console.log(`      ↩️ reuso documents existentes: ${existingDocs.length} rows (t=${msSince(pdfT0)}ms)`);
      rows = existingDocs;
    } else {
      const tFetch0 = Date.now();
      const buffer = await fetchPdfBuffer(supabase, fileId, storagePath, editalPrefix);
      if (!buffer?.length) {
        console.warn(`   ⚠️ PDF vazio ou não encontrado: ${fileId}`);
        failDelta++;
        return { chunksDelta, okDelta, failDelta };
      }
      console.log(`      ⬇️ download ok bytes=${buffer.length} (t=${msSince(tFetch0)}ms, total=${msSince(pdfT0)}ms)`);

      const tExtract0 = Date.now();
      const text = await extractTextFromPdf(buffer);
      if (!text || text.length < 50) {
        console.warn(`   ⚠️ Texto extraído curto: ${fileId}`);
        failDelta++;
        return { chunksDelta, okDelta, failDelta };
      }
      console.log(`      🧾 extração ok chars=${text.length} (t=${msSince(tExtract0)}ms, total=${msSince(pdfT0)}ms)`);

      const tChunk0 = Date.now();
      const rawChunks = chunkText(text, CHUNK_SIZE, CHUNK_OVERLAP);
      const chunks = rawChunks.map((c) => sanitizeChunkContent(c)).filter((c) => c.length > 0);
      if (!chunks.length) {
        console.warn(`   ⚠️ Sem chunks: ${fileId}`);
        failDelta++;
        return { chunksDelta, okDelta, failDelta };
      }
      console.log(
        `      ✂️ chunking ok chunks=${chunks.length} (t=${msSince(tChunk0)}ms, total=${msSince(pdfT0)}ms)`,
      );

      if (rebuild) {
        const tDel0 = Date.now();
        await withRetry(() => supabase.from("documents").delete().eq("file_id", String(fileId)), {
          label: "delete old chunks (rebuild)",
        });
        console.log(`      🧹 delete old chunks (rebuild) ok (t=${msSince(tDel0)}ms, total=${msSince(pdfT0)}ms)`);
      }

      const tEnrich0 = Date.now();
      const maxEnrich = enrichMaxChunksPerPdf();
      const enrichResults = await mapWithConcurrency(chunks, enrichOn ? enrichConcurrency() : 1, async (plain, ci) => {
        const skipLlm = maxEnrich > 0 && ci >= maxEnrich;
        const { embeddingText, embeddingRetrievalText, enrichment, enrichFailed } = skipLlm
          ? {
              embeddingText: plain,
              embeddingRetrievalText: plain,
              enrichment: null,
              enrichFailed: false,
            }
          : await enrichChunkForRetrieval(plain, { chunkIndex: ci });
        if (ci > 0 && ci % 25 === 0) {
          console.log(`      🧩 enrich progress: ${ci}/${chunks.length} (total=${msSince(pdfT0)}ms)`);
        }
        return {
          file_id: String(fileId),
          content: embeddingText,
          retrievalEmbedInput: embeddingRetrievalText,
          metadata: {
            file_id: String(fileId),
            edital_id: editalIdSafe,
            chunk_index: ci,
            chunk_plain_preview: plain.slice(0, 1500),
            enrichment: enrichment || undefined,
            enrich_failed: Boolean(enrichFailed),
            enrich_skipped_llm: skipLlm || undefined,
            embed_truncates_at: parseInt(process.env.EMBED_MAX_CHARS_PER_INPUT || "512", 10),
          },
        };
      });
      const enrichedRows = enrichResults;
      console.log(
        `      🧩 enrich done chunks=${enrichedRows.length} (t=${msSince(tEnrich0)}ms, total=${msSince(pdfT0)}ms)`,
      );

      let embeddingsForInsert;
      let embeddingsPerguntasForInsert;
      const embedPerg = embedPerguntasColumnEnabled();
      try {
        const tEmb0 = Date.now();
        const textsFull = enrichedRows.map((r) => r.content);
        console.log(
          `      🧠 embedding (pre-insert) start chunks=${enrichedRows.length} perguntas_col=${embedPerg ? "sim" : "não"}`,
        );
        if (embedPerg) {
          const textsRetrieval = enrichedRows.map((r) => r.retrievalEmbedInput);
          const [full, perg] = await Promise.all([
            withRetry(() => embedWithOllamaBatched(textsFull), { label: "ollama embed full (pre-insert)" }),
            withRetry(() => embedWithOllamaBatched(textsRetrieval), { label: "ollama embed perguntas (pre-insert)" }),
          ]);
          embeddingsForInsert = full;
          embeddingsPerguntasForInsert = perg;
        } else {
          embeddingsForInsert = await withRetry(() => embedWithOllamaBatched(textsFull), { label: "ollama embed (pre-insert)" });
          embeddingsPerguntasForInsert = null;
        }
        console.log(
          `      🧠 embedding (pre-insert) ok n=${embeddingsForInsert?.length ?? 0} (t=${msSince(tEmb0)}ms, total=${msSince(pdfT0)}ms)`,
        );
      } catch (e) {
        console.error(`   ❌ embed (pre-insert):`, e instanceof Error ? e.message : e);
        if (!(await isPdfFullyIndexed(supabase, fileId))) await markPdfProcessingState(supabase, pdf, false);
        failDelta++;
        return { chunksDelta, okDelta, failDelta };
      }

      if (!Array.isArray(embeddingsForInsert) || embeddingsForInsert.length !== enrichedRows.length) {
        console.warn(`   ⚠️ embeddings ${embeddingsForInsert?.length ?? 0} ≠ chunks ${enrichedRows.length}`);
        if (!(await isPdfFullyIndexed(supabase, fileId))) await markPdfProcessingState(supabase, pdf, false);
        failDelta++;
        return { chunksDelta, okDelta, failDelta };
      }
      if (
        embedPerg &&
        (!Array.isArray(embeddingsPerguntasForInsert) || embeddingsPerguntasForInsert.length !== enrichedRows.length)
      ) {
        console.warn(`   ⚠️ embeddings perguntas ${embeddingsPerguntasForInsert?.length ?? 0} ≠ chunks ${enrichedRows.length}`);
        if (!(await isPdfFullyIndexed(supabase, fileId))) await markPdfProcessingState(supabase, pdf, false);
        failDelta++;
        return { chunksDelta, okDelta, failDelta };
      }

      const tDel0 = Date.now();
      await withRetry(() => supabase.from("documents").delete().eq("file_id", String(fileId)), {
        label: "delete old chunks",
      });
      console.log(`      🧹 delete old chunks ok (t=${msSince(tDel0)}ms, total=${msSince(pdfT0)}ms)`);

      const rowsToInsert = enrichedRows.map((r, idx) => {
        const row = {
          file_id: r.file_id,
          content: r.content,
          metadata: r.metadata,
          embedding: embeddingsForInsert[idx],
        };
        if (embedPerg && Array.isArray(embeddingsPerguntasForInsert) && embeddingsPerguntasForInsert[idx]?.length) {
          row.embedding_perguntas = embeddingsPerguntasForInsert[idx];
        } else {
          row.embedding_perguntas = null;
        }
        return row;
      });
      const tIns0 = Date.now();
      const { data: inserted, error: insertErr } = await withRetry(
        () =>
          supabase.from("documents").insert(rowsToInsert).select("id, content, embedding, embedding_perguntas, metadata"),
        { label: "insert chunks (with embedding)" },
      );
      console.log(`      📥 insert ok rows=${inserted?.length ?? 0} (t=${msSince(tIns0)}ms, total=${msSince(pdfT0)}ms)`);

      if (insertErr) {
        console.error(`   ❌ insert chunks:`, insertErr.message);
        if (!(await isPdfFullyIndexed(supabase, fileId))) await markPdfProcessingState(supabase, pdf, false);
        failDelta++;
        return { chunksDelta, okDelta, failDelta };
      }

      rows = inserted || [];
      chunksDelta += rows.length;
    }

    let embeddings;
    try {
      const toEmbed = rows.filter((r) => !r.embedding || (Array.isArray(r.embedding) && r.embedding.length === 0));
      if (toEmbed.length === 0) {
        embeddings = [];
      } else {
        console.log(`      🧠 embedding repair start missing=${toEmbed.length} rows (total=${msSince(pdfT0)}ms)`);
        embeddings = await withRetry(() => embedWithOllamaBatched(toEmbed.map((r) => r.content)), { label: "ollama embed" });
        console.log(`      🧠 embedding repair ok n=${embeddings.length} (total=${msSince(pdfT0)}ms)`);
      }
    } catch (e) {
      console.error(`   ❌ embed:`, e instanceof Error ? e.message : e);
      if (!(await isPdfFullyIndexed(supabase, fileId))) await markPdfProcessingState(supabase, pdf, false);
      failDelta++;
      return { chunksDelta, okDelta, failDelta };
    }

    let ok = 0;
    const embedTargets = rows.filter((r) => !r.embedding || (Array.isArray(r.embedding) && r.embedding.length === 0));
    if (embedTargets.length > 0) {
      if (embeddings.length !== embedTargets.length) {
        console.warn(`   ⚠️ embeddings ${embeddings.length} ≠ rows sem embedding ${embedTargets.length}`);
        if (!(await isPdfFullyIndexed(supabase, fileId))) await markPdfProcessingState(supabase, pdf, false);
        failDelta++;
        return { chunksDelta, okDelta, failDelta };
      }
      const tUpd0 = Date.now();
      for (let j = 0; j < embedTargets.length; j++) {
        const emb = embeddings[j];
        if (!emb?.length) break;
        const targetId = embedTargets[j].id;
        const { error: upErr } = await withRetry(
          () => supabase.from("documents").update({ embedding: emb }).eq("id", targetId),
          { label: "update embedding" },
        );
        if (upErr) {
          console.warn(`   ⚠️ update embedding:`, upErr.message);
          failDelta++;
          ok = -1;
          break;
        }
        ok++;
        okDelta++;
        if (j > 0 && j % 50 === 0) {
          console.log(`      🧷 update embedding progress: ${j}/${embedTargets.length} (total=${msSince(pdfT0)}ms)`);
        }
      }
      console.log(`      🧷 update embedding done ok=${ok}/${embedTargets.length} (t=${msSince(tUpd0)}ms)`);
    }

    if (embedPerguntasColumnEnabled() && ok !== -1) {
      const missPerg = rows.filter((r) => {
        const hasMain = r.embedding && (Array.isArray(r.embedding) ? r.embedding.length > 0 : true);
        const hasP =
          r.embedding_perguntas &&
          (Array.isArray(r.embedding_perguntas) ? r.embedding_perguntas.length > 0 : false);
        return Boolean(hasMain && !hasP && typeof r.content === "string" && r.content.length > 0);
      });
      if (missPerg.length > 0) {
        try {
          const texts = missPerg.map((r) => retrievalEmbeddingInputFromChunkContent(r.content));
          const embs = await withRetry(() => embedWithOllamaBatched(texts), { label: "ollama embed perguntas (reuse)" });
          if (Array.isArray(embs) && embs.length === missPerg.length) {
            for (let j = 0; j < missPerg.length; j++) {
              const emb = embs[j];
              if (!emb?.length) continue;
              const { error: pe } = await withRetry(
                () => supabase.from("documents").update({ embedding_perguntas: emb }).eq("id", missPerg[j].id),
                { label: "update embedding_perguntas" },
              );
              if (pe) console.warn(`   ⚠️ update embedding_perguntas:`, pe.message);
            }
            console.log(`      🧠 embedding_perguntas (reuse) ok n=${missPerg.length} (total=${msSince(pdfT0)}ms)`);
          }
        } catch (e) {
          console.warn(`   ⚠️ embedding_perguntas reuse skip:`, e instanceof Error ? e.message : e);
        }
      }
    }

    if (ok === -1) {
      if (!(await isPdfFullyIndexed(supabase, fileId))) await markPdfProcessingState(supabase, pdf, false);
      return { chunksDelta, okDelta, failDelta };
    }

    const { total, missing } = await countMissingEmbeddings(supabase, fileId);
    const fullyProcessed = total > 0 && missing === 0;
    // Se tentamos reparar e ainda falta embedding, limpa para evitar estado parcial persistente.
    if (!fullyProcessed && shouldReuseExisting && total > 0) {
      console.warn(
        `   ⚠️ limpeza: ${fileId} ainda com embeddings faltando (${missing}/${total}); apagando chunks para reprocessar depois`,
      );
      await withRetry(() => supabase.from("documents").delete().eq("file_id", String(fileId)), {
        label: "cleanup partial chunks",
      });
    }
    await markPdfProcessingState(supabase, pdf, fullyProcessed);
    if (fullyProcessed) {
      console.log(
        `   ✅ [${i + 1}/${toProcess.length}] ${pdf.edital_id || fileId}: ${total} chunks (reuso=${shouldReuseExisting}) → is_processed (total=${msSince(pdfT0)}ms)`,
      );
    } else {
      console.warn(
        `   ⚠️ [${i + 1}/${toProcess.length}] ${pdf.edital_id || fileId}: ainda faltam embeddings (${missing}/${total}); is_processed=false (total=${msSince(pdfT0)}ms)`,
      );
      failDelta++;
    }
    return { chunksDelta, okDelta, failDelta };
  }

  for (let i = 0; i < toProcess.length; i++) {
    const r = await processOne(toProcess[i], i);
    if (!r) continue;
    totalChunks += r.chunksDelta || 0;
    totalOk += r.okDelta || 0;
    totalFail += r.failDelta || 0;
  }

  const durationMs = Date.now() - startedAt;
  console.log(`\n[document-processor] resumo: chunks gravados=${totalChunks}, embeddings ok=${totalOk}, falhas pdf=${totalFail}, ${durationMs}ms`);
  if (totalChunks > 0 && totalOk === 0) {
    console.warn(
      "[document-processor] ⚠️ chunks gravados mas 0 embeddings ok — verifique OLLAMA_BASE_URL, OLLAMA_EMBED_MODEL e logs de 'embed (pre-insert)'; process-edital top-k fica degradado.",
    );
  }

  try {
    await publishDomainEvent(
      makeEventBase({
        name: "DocumentProcessingCompleted",
        severity: totalFail > 0 || (totalChunks > 0 && totalOk === 0) ? "warn" : "info",
        message: `Document processing finished: ${totalChunks} chunks, ${totalOk} embeddings, ${totalFail} failures`,
        component: "document.processor",
        props: { duration_ms: durationMs, total_chunks: totalChunks, embeddings_ok: totalOk, pdf_failures: totalFail },
      }),
    );
  } catch (e) {
    console.warn("[document-processor] warn: EventBridge:", e instanceof Error ? e.message : e);
  }

  return { queueLength: toProcess.length };
}

async function main() {
  const argv = process.argv.slice(2);
  if (ecsWorkerLoopEnabled() && argv.length === 0) {
    let iter = 0;
    console.log(
      `[document-processor] ECS_WORKER_LOOP=1 — execução contínua. Idle após trabalho=${workerIdleMsAfterWork()}ms; fila vazia=${workerIdleMsNoWork()}ms`,
    );
    while (true) {
      iter += 1;
      console.log(`\n[document-processor] worker iter=${iter} @ ${new Date().toISOString()}`);
      try {
        const { queueLength } = await runDocumentProcessor([]);
        const idle = queueLength === 0 ? workerIdleMsNoWork() : workerIdleMsAfterWork();
        if (idle > 0) await sleep(idle);
      } catch (e) {
        console.error("[document-processor] worker iter erro:", e);
        await sleep(workerIdleMsNoWork());
      }
    }
  }

  await runDocumentProcessor(argv);
}

const isDirectCliRun =
  typeof process.argv[1] === "string" &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectCliRun) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
