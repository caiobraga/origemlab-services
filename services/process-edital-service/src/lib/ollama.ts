import { describeFetchError } from "./fetchError";
import { ollamaFetch } from "./ollamaHttp";
import {
  getResolvedOllamaBaseUrl,
  getResolvedOllamaEmbedModel,
  getResolvedOllamaModel,
} from "./ollamaResolve";
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

export function getOllamaGenerateTimeoutMs(): number {
  const raw = String(process.env.OLLAMA_GENERATE_TIMEOUT_MS || "").trim();
  if (raw) {
    const g = parseInt(raw, 10);
    if (Number.isFinite(g) && g > 0) return clampTimeoutMs(g, 900_000);
  }
  // NLB: fail-fast — 10 min por chamada bloqueia o lote inteiro sem garantir resposta.
  return clampTimeoutMs(180_000, 180_000);
}

function getOllamaGenerateRetries(): number {
  const raw = parseInt(process.env.OLLAMA_GENERATE_RETRIES || "1", 10);
  return Number.isFinite(raw) ? Math.max(1, Math.min(3, raw)) : 1;
}

function getOllamaNumPredict(): number {
  const raw = parseInt(process.env.OLLAMA_NUM_PREDICT || "384", 10);
  return Number.isFinite(raw) ? Math.max(64, Math.min(2048, raw)) : 384;
}

export function isOllamaGenerateTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Ollama generate/i.test(msg) && /timed out after \d+ms|fetch aborted/i.test(msg);
}

export function isOllamaEmbedTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /Ollama embed/i.test(msg) && /timed out after \d+ms|fetch aborted/i.test(msg);
}

export function isOllamaTimeout(err: unknown): boolean {
  return isOllamaGenerateTimeout(err) || isOllamaEmbedTimeout(err);
}

let generateGapChain: Promise<void> = Promise.resolve();
let lastGenerateEndMs = 0;

async function waitGenerateGap(): Promise<void> {
  const gap = parseInt(process.env.PROCESS_EDITAL_GENERATE_DELAY_MS || "800", 10) || 800;
  generateGapChain = generateGapChain.then(async () => {
    const wait = Math.max(0, gap - (Date.now() - lastGenerateEndMs));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  });
  await generateGapChain;
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

/** Limite de contexto por chamada de extração (top-k / bulk / janela). */
export function getMaxFieldContextChars(): number {
  const fieldRaw = parseInt(process.env.PROCESS_EDITAL_MAX_FIELD_CONTEXT_CHARS || "", 10);
  const fieldCap = Number.isFinite(fieldRaw) && fieldRaw > 0 ? fieldRaw : 4500;
  return Math.min(getMaxContextChars(), Math.max(2000, fieldCap));
}

export function getTopKPackMaxChars(): number {
  const raw = parseInt(process.env.PROCESS_EDITAL_TOPK_PACK_MAX_CHARS || "", 10);
  if (Number.isFinite(raw) && raw > 0) return Math.min(getMaxContextChars(), raw);
  return getMaxFieldContextChars();
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
        options: {
          temperature: Number.isFinite(temperature) ? temperature : 0,
          num_predict: getOllamaNumPredict(),
        },
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
  await waitGenerateGap();
  const baseUrl = getOllamaBaseUrl();
  const model = getOllamaModel();
  const timeoutMs = getOllamaGenerateTimeoutMs();
  try {
    return await withRetry(() => ollamaGenerateOnce(prompt, baseUrl, model, timeoutMs), {
      label: "ollama generate",
      attempts: getOllamaGenerateRetries(),
    });
  } finally {
    lastGenerateEndMs = Date.now();
  }
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