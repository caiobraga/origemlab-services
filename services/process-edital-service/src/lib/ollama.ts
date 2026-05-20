import { describeFetchError } from "./fetchError";
import { ollamaFetch } from "./ollamaHttp";
import { withRetry } from "./retry";

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
  // fallback: if only one model is configured, allow it to be reused
  return getOllamaModel();
}

function clampTimeoutMs(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 10_000), 1_800_000); /* 10s .. 30m */
}

export function getOllamaTimeoutMs(): number {
  const raw = parseInt(process.env.OLLAMA_TIMEOUT_MS || "600000", 10);
  return clampTimeoutMs(raw, 600_000);
}

function getOllamaGenerateTimeoutMs(): number {
  const raw = String(process.env.OLLAMA_GENERATE_TIMEOUT_MS || "").trim();
  if (raw) {
    const g = parseInt(raw, 10);
    if (Number.isFinite(g) && g > 0) return clampTimeoutMs(g, 900_000);
  }
  // /api/generate é mais lento que embed; não herdar OLLAMA_TIMEOUT_MS=240000 do repo global.
  return clampTimeoutMs(900_000, 900_000);
}

function getOllamaEmbedTimeoutMs(): number {
  const e = parseInt(process.env.OLLAMA_EMBED_TIMEOUT_MS || "", 10);
  if (Number.isFinite(e) && e > 0) return clampTimeoutMs(e, getOllamaTimeoutMs());
  return getOllamaTimeoutMs();
}

function wrapOllamaFetchError(err: unknown, timeoutMs: number, label: string, baseUrl: string): Error {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || /aborted|AbortError|The operation was aborted/i.test(msg)) {
    return new Error(
      `Ollama ${label} timed out after ${timeoutMs}ms (fetch aborted). URL=${baseUrl}. For large prompts/models, raise OLLAMA_TIMEOUT_MS or OLLAMA_GENERATE_TIMEOUT_MS / OLLAMA_EMBED_TIMEOUT_MS.`,
    );
  }
  if (msg === "fetch failed" || msg.startsWith("fetch failed")) {
    return new Error(`Ollama ${label} (${baseUrl}): ${describeFetchError(err)}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

export function getMaxContextChars(): number {
  const n = parseInt(process.env.OLLAMA_MAX_CONTEXT_CHARS || "10000", 10);
  return Number.isFinite(n) ? Math.max(2000, n) : 10_000;
}

async function ollamaGenerateOnce(prompt: string, baseUrl: string, model: string, timeoutMs: number): Promise<string> {
  const temperature = parseFloat(process.env.OLLAMA_TEMPERATURE || "0");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await ollamaFetch(`${baseUrl}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: Number.isFinite(temperature) ? temperature : 0 },
      }),
      signal: controller.signal,
    }, timeoutMs);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${text.slice(0, 800)}`);
    }
    const json = JSON.parse(text) as OllamaGenerateResponse;
    return String(json.response || "").trim();
  } catch (e) {
    throw wrapOllamaFetchError(e, timeoutMs, "generate (/api/generate)", baseUrl);
  } finally {
    clearTimeout(t);
  }
}

export async function ollamaGenerate(prompt: string): Promise<string> {
  const baseUrl = getOllamaBaseUrl();
  const model = getOllamaModel();
  const timeoutMs = getOllamaGenerateTimeoutMs();
  return withRetry(() => ollamaGenerateOnce(prompt, baseUrl, model, timeoutMs), {
    label: "ollama generate",
    attempts: parseInt(process.env.OLLAMA_FETCH_RETRIES || "3", 10) || 3,
  });
}

async function ollamaEmbedOnce(input: string, baseUrl: string, model: string, timeoutMs: number): Promise<number[]> {
  const dimensionsRaw = (process.env.EMBED_DIMENSIONS || process.env.OLLAMA_EMBED_DIMENSIONS || "").trim();
  const dimensions = dimensionsRaw ? parseInt(dimensionsRaw, 10) : null;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body: Record<string, unknown> = { model, input };
    if (dimensions && Number.isFinite(dimensions) && dimensions > 0) body.dimensions = dimensions;

    const res = await ollamaFetch(`${baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, timeoutMs);

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Ollama embed error ${res.status}: ${text.slice(0, 800)}`);
    }
    const json = JSON.parse(text) as OllamaEmbedResponse;
    const emb = Array.isArray(json.embeddings) ? json.embeddings[0] : json.embedding;
    if (!Array.isArray(emb) || emb.length === 0) throw new Error("Ollama embed: empty embedding");
    return emb.map((x) => Number(x));
  } catch (e) {
    throw wrapOllamaFetchError(e, timeoutMs, "embed (/api/embed)", baseUrl);
  } finally {
    clearTimeout(t);
  }
}

export async function ollamaEmbed(input: string): Promise<number[]> {
  const baseUrl = getOllamaBaseUrl();
  const model = getOllamaEmbedModel();
  const timeoutMs = getOllamaEmbedTimeoutMs();
  return withRetry(() => ollamaEmbedOnce(input, baseUrl, model, timeoutMs), {
    label: "ollama embed",
    attempts: parseInt(process.env.OLLAMA_FETCH_RETRIES || "3", 10) || 3,
  });
}

