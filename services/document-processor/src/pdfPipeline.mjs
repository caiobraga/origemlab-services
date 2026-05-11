import { createClient } from "@supabase/supabase-js";
import WebSocket from "ws";

export const STORAGE_BUCKET = "edital-pdfs";

export function getSupabase() {
  const url = (process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || "").trim();
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || "").trim();
  if (!url || !key) throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  const hasNativeWs = typeof globalThis.WebSocket !== "undefined";
  if (hasNativeWs) return createClient(url, key);
  // Node < 22: Supabase Realtime precisa de WebSocket constructor.
  return createClient(url, key, {
    realtime: {
      transport: WebSocket,
    },
  });
}

/** @typedef {{ fonte: string, numero: string }} EditalPrefix */

export async function fetchPdfBuffer(supabase, fileId, caminhoStorage, editalPrefix) {
  const ref = String(fileId || "").trim();
  if (!ref) return null;

  let storagePath = caminhoStorage?.trim() || "";
  if (!storagePath.includes("/")) {
    const { data: pdfRecord } = await supabase.from("edital_pdfs").select("caminho_storage").eq("id", ref).maybeSingle();
    if (pdfRecord?.caminho_storage) {
      storagePath = pdfRecord.caminho_storage;
    } else {
      const { data: byFid } = await supabase.from("edital_pdfs").select("caminho_storage").eq("file_id", ref).maybeSingle();
      if (byFid?.caminho_storage) storagePath = byFid.caminho_storage;
      else {
        const { data: bucketRow } = await supabase.schema("storage").from("buckets").select("id").eq("name", STORAGE_BUCKET).maybeSingle();
        const bucketId = bucketRow?.id;
        if (bucketId) {
          const { data: obj } = await supabase
            .schema("storage")
            .from("objects")
            .select("name")
            .eq("bucket_id", bucketId)
            .eq("id", ref)
            .maybeSingle();
          if (obj?.name) storagePath = obj.name;
        }
        if (!storagePath && editalPrefix?.fonte && editalPrefix?.numero) {
          const prefix = `${editalPrefix.fonte}/${editalPrefix.numero}`;
          try {
            const { data: listData } = await supabase.storage.from(STORAGE_BUCKET).list(prefix);
            const items = listData || [];
            const withName = items.filter((f) => f.name && !f.name.endsWith("/"));
            if (withName.length) {
              const match = withName.find((f) => f.id === ref);
              if (match?.name) storagePath = `${prefix}/${match.name}`;
              else if (withName.length === 1) storagePath = `${prefix}/${withName[0].name}`;
            }
          } catch {
            // ignore
          }
        }
        if (!storagePath) storagePath = ref;
      }
    }
  }

  const { data: fileData, error } = await supabase.storage.from(STORAGE_BUCKET).download(storagePath);
  if (error || !fileData) return null;
  const arrayBuffer = await fileData.arrayBuffer();
  const buf = Buffer.from(arrayBuffer);
  return buf.length > 0 ? buf : null;
}

export async function extractTextFromPdf(buffer) {
  try {
    const { PDFParse } = await import("pdf-parse");
    const parser = new (PDFParse)({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    await parser.destroy();
    return (result?.text || "").trim().replace(/\s+/g, " ");
  } catch {
    return "";
  }
}

export function sanitizeChunkContent(s) {
  return s
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, " ")
    .replace(/\\/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function chunkText(text, size, overlap) {
  const chunks = [];
  let start = 0;
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (!trimmed) return [];
  while (start < trimmed.length) {
    const end = Math.min(start + size, trimmed.length);
    const chunk = trimmed.slice(start, end).trim();
    if (chunk.length > 0) chunks.push(chunk);
    if (end >= trimmed.length) break;
    start = Math.max(start + 1, end - overlap);
  }
  return chunks;
}
