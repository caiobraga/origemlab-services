import { describeFetchError, isTransientFetchError } from "./fetchError.mjs";

function ollamaBaseUrl() {
  return (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
}

function embedFetchRetries() {
  const n = parseInt(process.env.OLLAMA_FETCH_RETRIES || "3", 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(6, n)) : 3;
}

function embedDimensions() {
  return process.env.EMBED_DIMENSIONS ? parseInt(process.env.EMBED_DIMENSIONS, 10) : null;
}

function embedBatchSize() {
  return Math.max(1, parseInt(process.env.EMBED_BATCH_SIZE || "8", 10));
}

function embedMaxCharsPerBatch() {
  return Math.max(100, parseInt(process.env.EMBED_MAX_CHARS_PER_BATCH || "2048", 10));
}

function embedMaxCharsPerInput() {
  return Math.max(100, parseInt(process.env.EMBED_MAX_CHARS_PER_INPUT || "512", 10));
}

async function embedWithOllama(texts) {
  if (texts.length === 0) return [];
  const base = ollamaBaseUrl();
  const url = `${base}/api/embed`;
  const input = texts.length === 1 ? texts[0] : texts;
  const model = process.env.OLLAMA_EMBED_MODEL || "mxbai-embed-large:latest";
  const body = { model, input };
  const dim = embedDimensions();
  if (dim != null && dim > 0) body.dimensions = dim;

  const attempts = embedFetchRetries();
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Ollama embed: ${res.status} ${(await res.text()).slice(0, 500)}`);
      const data = await res.json();
      return data.embeddings || [];
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message : String(e);
      const wrapped =
        msg === "fetch failed" || msg.startsWith("fetch failed")
          ? new Error(`Ollama embed (${base}): ${describeFetchError(e)}`)
          : e instanceof Error
            ? e
            : new Error(String(e));
      if (i >= attempts - 1 || !isTransientFetchError(wrapped)) throw wrapped;
      const delay = 1500 * (i + 1);
      console.warn(`⚠️ ollama embed: retry ${i + 1}/${attempts} em ${delay}ms — ${wrapped.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

function buildEmbedBatches(texts) {
  if (texts.length === 0) return [];
  const batches = [];
  let i = 0;
  const maxBatch = embedBatchSize();
  const maxCharsBatch = embedMaxCharsPerBatch();
  while (i < texts.length) {
    const batch = [];
    let totalChars = 0;
    while (i < texts.length && batch.length < maxBatch) {
      const t = texts[i];
      const len = t.length;
      if (totalChars + len > maxCharsBatch && batch.length > 0) break;
      batch.push(t);
      totalChars += len;
      i++;
    }
    if (batch.length > 0) batches.push(batch);
  }
  return batches;
}

function truncateForEmbed(texts) {
  const maxIn = embedMaxCharsPerInput();
  if (maxIn <= 0) return texts;
  return texts.map((t) => (t.length <= maxIn ? t : t.slice(0, maxIn)));
}

export async function embedWithOllamaBatched(texts) {
  if (texts.length === 0) return [];
  const truncated = truncateForEmbed(texts);
  const batches = buildEmbedBatches(truncated);
  const out = [];
  for (const batch of batches) {
    const batchEmbeddings = await embedWithOllama(batch);
    out.push(...batchEmbeddings);
  }
  return out;
}
