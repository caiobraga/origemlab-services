#!/usr/bin/env node
/**
 * PDF → texto → chunks → (opcional) enriquecimento LLM alinhado ao process-edital-info → documents + embedding.
 * Baseado em originlab/scripts/db/populate-documents-from-pdfs.ts com etapa extra enrichChunkForRetrieval.
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OLLAMA_BASE_URL, OLLAMA_CHAT_MODEL, OLLAMA_EMBED_MODEL,
 *      CHUNK_SIZE, CHUNK_OVERLAP, ENRICH_CHUNKS=1|0, CHUNK_ENRICH_DELAY_MS, DISABLE_EVENTBRIDGE
 */
import { loadEnv } from "./loadEnv.mjs";
import { enrichChunkForRetrieval, enrichDelayMs } from "./enrichChunk.mjs";
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
  const args = { dryRun: false, processAll: false, rebuild: false, limit: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    if (a === "--all") args.processAll = true;
    if (a === "--rebuild") args.rebuild = true;
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
        .select("id, content, embedding, metadata")
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
    () => supabase.from("documents").select("id, embedding").eq("file_id", fid),
    { label: "check embeddings" },
  );
  if (error) throw error;
  const rows = data || [];
  const missing = rows.filter((r) => !r.embedding || (Array.isArray(r.embedding) && r.embedding.length === 0)).length;
  return { total: rows.length, missing };
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

async function main() {
  const { dryRun, processAll, rebuild, limit } = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const supabase = getSupabase();

  console.log("[document-processor] PDF → chunks → enrich (process-edital context) → embed → documents");
  console.log(`   chunk size=${CHUNK_SIZE} overlap=${CHUNK_OVERLAP} enrich=${process.env.ENRICH_CHUNKS ?? "1"}`);
  if (dryRun) console.log("   mode: --dry-run");
  if (rebuild) console.log("   mode: --rebuild (força recriar chunks)");

  await cleanupOldNullEmbeddings(supabase);

  const toProcess = await loadProcessingQueue(supabase, { processAll, limit });
  console.log(`   PDFs na fila: ${toProcess.length}`);
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
  const delayEnrich = enrichDelayMs();

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
      const enrichedRows = [];
      for (let ci = 0; ci < chunks.length; ci++) {
        if (delayEnrich > 0 && ci > 0) await sleep(delayEnrich);
        const plain = chunks[ci];
        const { embeddingText, enrichment, enrichFailed } = await enrichChunkForRetrieval(plain, { chunkIndex: ci });
        if (ci > 0 && ci % 50 === 0) {
          console.log(`      🧩 enrich progress: ${ci}/${chunks.length} chunks (total=${msSince(pdfT0)}ms)`);
        }
        enrichedRows.push({
          file_id: String(fileId),
          content: embeddingText,
          // embedding preenchido depois (antes do insert)
          metadata: {
            file_id: String(fileId),
            edital_id: editalIdSafe,
            chunk_index: ci,
            chunk_plain_preview: plain.slice(0, 1500),
            enrichment: enrichment || undefined,
            enrich_failed: Boolean(enrichFailed),
            embed_truncates_at: parseInt(process.env.EMBED_MAX_CHARS_PER_INPUT || "512", 10),
          },
        });
      }
      console.log(`      🧩 enrich done chunks=${enrichedRows.length} (t=${msSince(tEnrich0)}ms, total=${msSince(pdfT0)}ms)`);

      let embeddingsForInsert;
      try {
        const tEmb0 = Date.now();
        console.log(`      🧠 embedding (pre-insert) start chunks=${enrichedRows.length}`);
        embeddingsForInsert = await withRetry(
          () => embedWithOllamaBatched(enrichedRows.map((r) => r.content)),
          { label: "ollama embed (pre-insert)" },
        );
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

      const tDel0 = Date.now();
      await withRetry(() => supabase.from("documents").delete().eq("file_id", String(fileId)), {
        label: "delete old chunks",
      });
      console.log(`      🧹 delete old chunks ok (t=${msSince(tDel0)}ms, total=${msSince(pdfT0)}ms)`);

      const rowsToInsert = enrichedRows.map((r, idx) => ({ ...r, embedding: embeddingsForInsert[idx] }));
      const tIns0 = Date.now();
      const { data: inserted, error: insertErr } = await withRetry(
        () => supabase.from("documents").insert(rowsToInsert).select("id, content, embedding, metadata"),
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

  try {
    await publishDomainEvent(
      makeEventBase({
        name: "DocumentProcessingCompleted",
        severity: totalFail > 0 ? "warning" : "info",
        message: `Document processing finished: ${totalChunks} chunks, ${totalOk} embeddings, ${totalFail} failures`,
        component: "document.processor",
        props: { duration_ms: durationMs, total_chunks: totalChunks, embeddings_ok: totalOk, pdf_failures: totalFail },
      }),
    );
  } catch (e) {
    console.warn("[document-processor] warn: EventBridge:", e instanceof Error ? e.message : e);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
