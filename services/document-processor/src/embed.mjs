function ollamaBaseUrl() {
  return (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
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
  const url = `${ollamaBaseUrl()}/api/embed`;
  const input = texts.length === 1 ? texts[0] : texts;
  const model = process.env.OLLAMA_EMBED_MODEL || "mxbai-embed-large:latest";
  const body = { model, input };
  const dim = embedDimensions();
  if (dim != null && dim > 0) body.dimensions = dim;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ollama embed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embeddings || [];
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
