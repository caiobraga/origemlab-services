#!/usr/bin/env node
/**
 * Repara PDFs marcados como processados sem índice válido em `documents`
 * (conteúdo vazio, sem embedding, ou sem chunks).
 *
 * Uso:
 *   node scripts/fix-corrupt-pdf-index.mjs
 *   node scripts/fix-corrupt-pdf-index.mjs --apply
 *   node scripts/fix-corrupt-pdf-index.mjs --apply --since=2026-07-01
 *   node scripts/fix-corrupt-pdf-index.mjs --apply --reset-edital-stamp
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dir = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dir, "../../origemlab-backend/package.json"));
const { createClient } = require("@supabase/supabase-js");

const backendEnv = resolve(__dir, "../../origemlab-backend/.env.local");
const servicesEnv = resolve(__dir, "../.env.local");

function loadEnvFile(f) {
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i);
    const v = t.slice(i + 1);
    if (!process.env[k]) process.env[k] = v;
  }
}

loadEnvFile(servicesEnv);
loadEnvFile(backendEnv);

const apply = process.argv.includes("--apply");
const resetEditalStamp = process.argv.includes("--reset-edital-stamp");
const sinceArg = process.argv.find((a) => a.startsWith("--since="));
const since = sinceArg ? sinceArg.split("=")[1] : null;
const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Defina SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const sb = createClient(url, key);
const MIN_CONTENT = Math.max(10, parseInt(process.env.DOCUMENT_PROCESSOR_MIN_CONTENT_CHARS || "50", 10));

function pdfKey(p) {
  return String(p.file_id || p.id || "").trim();
}

async function indexHealth(fileId) {
  const fid = String(fileId || "").trim();
  if (!fid) return { total: 0, withContent: 0, withEmbedding: 0, ok: false };
  const { data, error } = await sb.from("documents").select("id, content, embedding").eq("file_id", fid);
  if (error) throw error;
  const rows = data ?? [];
  const withContent = rows.filter((r) => String(r.content || "").trim().length >= MIN_CONTENT).length;
  const withEmbedding = rows.filter(
    (r) => r.embedding && (Array.isArray(r.embedding) ? r.embedding.length > 0 : true),
  ).length;
  const ok = rows.length > 0 && withContent > 0 && withEmbedding === rows.length;
  return { total: rows.length, withContent, withEmbedding, ok };
}

async function loadPdfs() {
  const out = [];
  let from = 0;
  const page = 500;
  for (;;) {
    let q = sb.from("edital_pdfs").select("id, file_id, edital_id, is_processed, criado_em").order("criado_em", {
      ascending: false,
    });
    if (since) q = q.gte("criado_em", since);
    const { data, error } = await q.range(from, from + page - 1);
    if (error) throw error;
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < page) break;
    from += page;
  }
  return out;
}

async function main() {
  const pdfs = await loadPdfs();
  const corrupt = [];
  const seen = new Set();

  for (const p of pdfs) {
    const fid = pdfKey(p);
    if (!fid || seen.has(fid)) continue;
    seen.add(fid);
    if (p.is_processed !== true) continue;
    const h = await indexHealth(fid);
    if (!h.ok) corrupt.push({ pdf: p, fid, health: h });
    if (limit != null && limit > 0 && corrupt.length >= limit) break;
  }

  console.log("\n=== Reparo índice PDF (documents) ===\n");
  console.log(`Modo: ${apply ? "APLICAR" : "dry-run (use --apply)"}`);
  console.log(`Filtro since: ${since || "todos"}`);
  console.log(`PDFs analisados: ${seen.size}`);
  console.log(`Corrompidos (is_processed=true, índice inválido): ${corrupt.length}`);
  if (corrupt.length > 0) {
    console.log("\nExemplos:");
    for (const c of corrupt.slice(0, 8)) {
      const h = c.health;
      console.log(
        `  - file_id=${c.fid.slice(0, 12)}… edital=${c.pdf.edital_id ?? "—"} docs=${h.total} content=${h.withContent} embed=${h.withEmbedding}`,
      );
    }
  }

  if (!apply || corrupt.length === 0) {
    console.log("\nPróximo: node scripts/fix-corrupt-pdf-index.mjs --apply [--since=YYYY-MM-DD] [--reset-edital-stamp]");
    return;
  }

  let docsDeleted = 0;
  let pdfsReset = 0;
  const editalIds = new Set();

  for (const c of corrupt) {
    const fid = c.fid;
    const { error: delErr } = await sb.from("documents").delete().eq("file_id", fid);
    if (delErr) throw delErr;
    docsDeleted += c.health.total;

    const { error: pdfErr } = await sb.from("edital_pdfs").update({ is_processed: false }).eq("file_id", fid);
    if (pdfErr) throw pdfErr;
    pdfsReset++;

    if (c.pdf.edital_id) editalIds.add(String(c.pdf.edital_id));
  }

  let stampsReset = 0;
  if (resetEditalStamp && editalIds.size > 0) {
    const ids = [...editalIds];
    const chunk = 40;
    for (let i = 0; i < ids.length; i += chunk) {
      const slice = ids.slice(i, i + chunk);
      const { error } = await sb
        .from("editais")
        .update({ informacoes_processadas_em: null })
        .in("id", slice);
      if (error) throw error;
      stampsReset += slice.length;
    }
  }

  console.log(`\n✅ documents removidos: ${docsDeleted}`);
  console.log(`✅ edital_pdfs reenfileirados (is_processed=false): ${pdfsReset}`);
  if (resetEditalStamp) console.log(`✅ informacoes_processadas_em limpos: ${stampsReset}`);
  console.log("\nRode document-processor + unified-pipeline (ou process-edital + validate).");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
