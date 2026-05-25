import { describeFetchError } from "./fetchError";
import { ollamaFetch } from "./ollamaHttp";
import { getResolvedOllamaBaseUrl, getResolvedOllamaModel } from "./ollamaResolve";
import { withRetry } from "./retry";

type OllamaGenerateResponse = {
  response?: string;
};

function clampTimeoutMs(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, 10_000), 1_800_000);
}

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

export function getOllamaTimeoutMs(): number {
  const raw = parseInt(process.env.OLLAMA_TIMEOUT_MS || "240000", 10);
  return clampTimeoutMs(raw, 240_000);
}

export function getOllamaGenerateTimeoutMs(): number {
  const raw = String(process.env.OLLAMA_GENERATE_TIMEOUT_MS || "").trim();
  if (raw) {
    const g = parseInt(raw, 10);
    if (Number.isFinite(g) && g > 0) return clampTimeoutMs(g, 900_000);
  }
  return clampTimeoutMs(180_000, 180_000);
}

function getOllamaGenerateRetries(): number {
  const raw = parseInt(process.env.OLLAMA_GENERATE_RETRIES || "1", 10);
  return Number.isFinite(raw) ? Math.max(1, Math.min(3, raw)) : 1;
}

function getOllamaNumPredict(): number {
  const raw = parseInt(process.env.OLLAMA_NUM_PREDICT || "512", 10);
  return Number.isFinite(raw) ? Math.max(64, Math.min(2048, raw)) : 512;
}

export function isOllamaGenerateTimeout(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (/Ollama generate/i.test(msg) && /timed out after \d+ms|fetch aborted/i.test(msg)) return true;
  return /Ollama generate/i.test(msg) && isUndiciHeadersOrBodyTimeout(err);
}

function isUndiciHeadersOrBodyTimeout(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (/und_err_headers_timeout|und_err_body_timeout|headerstimeouterror|headers timeout error/i.test(msg)) {
    return true;
  }
  const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : null;
  if (cause instanceof Error) {
    const c = cause as Error & { code?: string };
    if (c.code === "UND_ERR_HEADERS_TIMEOUT" || c.code === "UND_ERR_BODY_TIMEOUT") return true;
    if (/headers timeout|body timeout/i.test(cause.message)) return true;
  }
  return false;
}

export function isOllamaTimeout(err: unknown): boolean {
  return isOllamaGenerateTimeout(err) || isUndiciHeadersOrBodyTimeout(err);
}

let generateGapChain: Promise<void> = Promise.resolve();
let lastGenerateEndMs = 0;

async function waitGenerateGap(): Promise<void> {
  const gap =
    parseInt(
      process.env.VALIDATE_GENERATE_DELAY_MS || process.env.PROCESS_EDITAL_GENERATE_DELAY_MS || "800",
      10,
    ) || 800;
  generateGapChain = generateGapChain.then(async () => {
    const wait = Math.max(0, gap - (Date.now() - lastGenerateEndMs));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  });
  await generateGapChain;
}

function wrapOllamaFetchError(err: unknown, timeoutMs: number, label: string, baseUrl: string): Error {
  const name = err instanceof Error ? err.name : "";
  const msg = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || /aborted|AbortError|The operation was aborted/i.test(msg)) {
    return new Error(
      `Ollama ${label} timed out after ${timeoutMs}ms (fetch aborted). URL=${baseUrl}. For large prompts/models, raise OLLAMA_GENERATE_TIMEOUT_MS.`,
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

/** Tamanho máximo do bloco DOCUMENTO por chamada de auditoria. */
export function getMaxAuditContextChars(): number {
  const validateRaw = parseInt(process.env.VALIDATE_AUDIT_MAX_CONTEXT_CHARS || "", 10);
  if (Number.isFinite(validateRaw) && validateRaw > 0) {
    return Math.min(getMaxContextChars(), Math.max(2000, validateRaw));
  }
  const sharedRaw = parseInt(process.env.PROCESS_EDITAL_MAX_FIELD_CONTEXT_CHARS || "", 10);
  if (Number.isFinite(sharedRaw) && sharedRaw > 0) {
    return Math.min(getMaxContextChars(), sharedRaw);
  }
  return Math.min(getMaxContextChars(), 4500);
}

async function ollamaGenerateOnce(prompt: string, baseUrl: string, model: string, timeoutMs: number): Promise<string> {
  const temperature = parseFloat(process.env.OLLAMA_TEMPERATURE || "0");
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await ollamaFetch(
      `${baseUrl}/api/generate`,
      {
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
      },
      timeoutMs,
    );

    const text = await res.text();
    if (!res.ok) throw new Error(`Ollama error ${res.status}: ${text.slice(0, 800)}`);
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
  const baseUrl = getResolvedOllamaBaseUrl();
  const model = getResolvedOllamaModel();
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
