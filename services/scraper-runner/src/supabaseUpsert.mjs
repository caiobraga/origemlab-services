import { createClient } from "@supabase/supabase-js";
import path from "node:path";
import { fetchWithScraperAgent } from "./fetchAgent.mjs";
import { describeFetchError } from "./httpFetch.mjs";
import { buildEditalTitulo, isSupplementTitle, isWeakLinkTitle } from "./scraperTitleUtils.mjs";
import { normalizePdfUrl, resolvePdfFetchUrl } from "./pdfUrlResolve.mjs";
import { normalizeDateForPostgres } from "./scraperDateUtils.mjs";

const STORAGE_BUCKET = "edital-pdfs";

function sanitizePathSegment(segment) {
  return String(segment || "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 100);
}

function sanitizeFileName(name) {
  let sanitized = name;
  try {
    sanitized = decodeURIComponent(sanitized);
  } catch {
    // ignore
  }
  sanitized = sanitized
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^_+|_+$/g, "")
    .substring(0, 200);
  if (!sanitized.toLowerCase().endsWith(".pdf")) sanitized = `${sanitized}.pdf`;
  return sanitized || "edital.pdf";
}

async function fetchPdf(url, timeoutMs = 45000) {
  const fetchUrl = resolvePdfFetchUrl(url);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchWithScraperAgent(fetchUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { Accept: "application/pdf,application/octet-stream,*/*" },
    });
    if (!res.ok) {
      throw new Error(
        `PDF fetch failed: HTTP ${res.status} for ${fetchUrl}${fetchUrl !== url ? ` (original: ${url})` : ""}`,
      );
    }
    const contentType = String(res.headers.get("content-type") || "").toLowerCase();
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    const looksLikePdf = buf.subarray(0, 1024).includes("%PDF-");
    if (!looksLikePdf) {
      const kind = contentType || "content-type desconhecido";
      throw new Error(`PDF fetch failed: resposta não é PDF (${kind}, ${buf.length} bytes) for ${fetchUrl}`);
    }
    return buf;
  } catch (e) {
    const base = e instanceof Error ? e : new Error(String(e));
    const msg = base.message?.startsWith("PDF fetch failed:") ? base.message : describeFetchError(base);
    throw new Error(`${msg} for ${url}`);
  } finally {
    clearTimeout(t);
  }
}

export function getSupabaseFromEnv() {
  const url = (process.env.SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }
  return createClient(url, key);
}

function normalizeEditalPayload(e) {
  const numero = e.numero ? String(e.numero).trim() : undefined;
  let titulo = buildEditalTitulo({ linkText: e.titulo, numero, fonte: e.fonte });
  if (!titulo || isSupplementTitle(titulo) || isWeakLinkTitle(titulo)) {
    if (!numero) return null;
    titulo = `Edital ${numero}`;
  }
  return { ...e, titulo, numero };
}

async function upsertEditalRow(supabase, e) {
  const norm = normalizeEditalPayload(e);
  if (!norm) return null;
  e = norm;
  const titulo = String(e.titulo || "").trim();
  if (!titulo) throw new Error("Edital missing titulo");

  const row = {
    titulo,
    fonte: e.fonte,
    processado_em: e.processadoEm || new Date().toISOString(),
  };
  if (e.numero) row.numero = e.numero;
  if (e.descricao) row.descricao = e.descricao;
  const dataPublicacao = normalizeDateForPostgres(e.dataPublicacao);
  if (dataPublicacao) row.data_publicacao = dataPublicacao;
  const dataEncerramento = normalizeDateForPostgres(e.dataEncerramento);
  if (dataEncerramento) row.data_encerramento = dataEncerramento;
  if (e.status) row.status = e.status;
  if (e.valor) row.valor = e.valor;
  if (e.area) row.area = e.area;
  if (e.orgao) row.orgao = e.orgao;
  if (e.link) row.link = e.link;

  if (e.numero) {
    const r = await supabase
      .from("editais")
      .upsert(row, { onConflict: "numero,fonte", ignoreDuplicates: false })
      .select("id")
      .single();
    if (r.error) throw r.error;
    return { id: r.data.id, created: false };
  }

  const existing = await supabase
    .from("editais")
    .select("id")
    .eq("fonte", e.fonte)
    .eq("titulo", titulo)
    .maybeSingle();
  if (existing.error) throw existing.error;

  if (existing.data?.id) {
    const upd = await supabase.from("editais").update(row).eq("id", existing.data.id);
    if (upd.error) throw upd.error;
    return { id: existing.data.id, created: false };
  }

  const ins = await supabase.from("editais").insert(row).select("id").single();
  if (ins.error) throw ins.error;
  return { id: ins.data.id, created: true };
}

// upsertEditalRow returns null when edital should be skipped (orphan supplement, etc.)

async function ensurePdf(supabase, editalId, e, pdfUrl) {
  pdfUrl = normalizePdfUrl(pdfUrl);
  const fonte = sanitizePathSegment(e.fonte || "unknown");
  const numero = sanitizePathSegment(e.numero || "unknown");
  const urlPath = new URL(pdfUrl).pathname;
  const fileName = sanitizeFileName(path.basename(urlPath) || "edital.pdf");
  const storagePath = `${fonte}/${numero}/${fileName}`;

  const existing = await supabase
    .from("edital_pdfs")
    .select("id")
    .eq("caminho_storage", storagePath)
    .maybeSingle();
  if (existing.error) throw existing.error;
  if (existing.data?.id) return { storagePath, created: false };

  const buf = await fetchPdf(pdfUrl);
  const up = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(storagePath, buf, { contentType: "application/pdf", upsert: true });
  if (up.error) throw up.error;

  const db = await supabase
    .from("edital_pdfs")
    .upsert(
      {
        edital_id: editalId,
        nome_arquivo: fileName,
        caminho_storage: storagePath,
        url_original: pdfUrl,
        tamanho_bytes: buf.length,
        tipo_mime: "application/pdf",
        is_processed: false,
      },
      { onConflict: "caminho_storage", ignoreDuplicates: false },
    );
  if (db.error) throw db.error;

  return { storagePath, created: true };
}

export async function upsertEditaisAndPdfs(supabase, editais) {
  const results = [];
  for (const e of editais) {
    const row = await upsertEditalRow(supabase, e);
    if (!row) {
      console.log(
        `[scraper-runner] skip edital (${e.fonte || "?"}): título inválido/suplemento sem número — ${String(e.titulo || "").slice(0, 80)}`,
      );
      continue;
    }
    const { id, created } = row;
    let newPdfs = 0;
    let failedPdfs = 0;
    for (const pdfUrl of e.pdfUrls || []) {
      try {
        const r = await ensurePdf(supabase, id, e, pdfUrl);
        if (r.created) newPdfs += 1;
      } catch (err) {
        failedPdfs += 1;
        const msg = err instanceof Error ? err.message : String(err);
        // Don't fail the whole source because one PDF link is broken.
        console.log(
          `[scraper-runner] warn: pdf upload failed (${e.fonte || "unknown"}): ${String(e.titulo || "").slice(0, 120)} - ${pdfUrl} - ${msg}`,
        );
      }
    }
    results.push({ fonte: e.fonte, titulo: e.titulo, editalId: id, created, newPdfs, failedPdfs });
  }
  return results;
}

