type OllamaGenerateResponse = {
  response?: string;
};

type OllamaEmbedResponse = {
  embeddings?: number[][];
  embedding?: number[];
};

export function getOllamaBaseUrl(): string {
  const base = (process.env.OLLAMA_BASE_URL || "").trim();
  if (!base) throw new Error("Missing OLLAMA_BASE_URL");
  return base.replace(/\/+$/, "");
}

export function getOllamaModel(): string {
  const m = (process.env.OLLAMA_MODEL || process.env.OLLAMA_CHAT_MODEL || "").trim();
  if (!m) throw new Error("Missing OLLAMA_MODEL (or OLLAMA_CHAT_MODEL)");
  return m;
}

export function getOllamaEmbedModel(): string {
  const m = (process.env.OLLAMA_EMBED_MODEL || "").trim();
  if (m) return m;
  return getOllamaModel();
}

export function getOllamaTimeoutMs(): number {
  const n = parseInt(process.env.OLLAMA_TIMEOUT_MS || "240000", 10);
  return Number.isFinite(n) ? Math.max(10_000, n) : 240_000;
}

export function getMaxContextChars(): number {
  const n = parseInt(process.env.OLLAMA_MAX_CONTEXT_CHARS || "22000", 10);
  return Number.isFinite(n) ? Math.max(2000, n) : 22000;
}

export async function ollamaGenerate(prompt: string): Promise<string> {
  const baseUrl = getOllamaBaseUrl();
  const model = getOllamaModel();
  const timeoutMs = getOllamaTimeoutMs();
  const temperature = parseFloat(process.env.OLLAMA_TEMPERATURE || "0");

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: Number.isFinite(temperature) ? temperature : 0 },
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${text.slice(0, 800)}`);
    const json = JSON.parse(text) as OllamaGenerateResponse;
    return String(json.response || "").trim();
  } finally {
    clearTimeout(t);
  }
}

export async function ollamaEmbed(input: string): Promise<number[]> {
  const baseUrl = getOllamaBaseUrl();
  const model = getOllamaEmbedModel();
  const timeoutMs = getOllamaTimeoutMs();
  const dimensionsRaw = (process.env.EMBED_DIMENSIONS || process.env.OLLAMA_EMBED_DIMENSIONS || "").trim();
  const dimensions = dimensionsRaw ? parseInt(dimensionsRaw, 10) : null;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = { model, input };
    if (dimensions && Number.isFinite(dimensions) && dimensions > 0) body.dimensions = dimensions;

    const res = await fetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Ollama embed error ${res.status}: ${text.slice(0, 800)}`);
    }
    const json = JSON.parse(text) as OllamaEmbedResponse;
    const emb = Array.isArray(json.embeddings) ? json.embeddings[0] : json.embedding;
    if (!Array.isArray(emb) || emb.length === 0) throw new Error("Ollama embed: empty embedding");
    return emb.map((x) => Number(x));
  } finally {
    clearTimeout(t);
  }
}
