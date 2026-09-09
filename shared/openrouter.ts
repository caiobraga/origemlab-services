/**
 * OpenRouter chat + embeddings client (OpenAI-compatible).
 * Embeddings are asserted to EMBED_DIMENSIONS (default 1024) for pgvector.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_CHAT_MODEL = "qwen/qwen-2.5-7b-instruct";
/** Native 1024-d multilingual embeddings — matches documents.embedding vector(1024). */
export const DEFAULT_EMBED_MODEL = "baai/bge-m3";
export const DEFAULT_EMBED_DIMENSIONS = 1024;

export type AiProvider = "openrouter" | "ollama";

export function getAiProvider(): AiProvider {
  const raw = String(process.env.AI_PROVIDER || "openrouter").trim().toLowerCase();
  return raw === "ollama" ? "ollama" : "openrouter";
}

export function getEmbedDimensions(): number {
  const raw = String(process.env.EMBED_DIMENSIONS || process.env.OLLAMA_EMBED_DIMENSIONS || "").trim();
  const n = raw ? parseInt(raw, 10) : DEFAULT_EMBED_DIMENSIONS;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EMBED_DIMENSIONS;
}

export type OpenRouterConfig = {
  apiKey: string;
  chatModel: string;
  embedModel: string;
  embedDimensions: number;
  timeoutMs: number;
  siteUrl?: string;
  siteName?: string;
};

export function loadOpenRouterConfig(overrides?: Partial<OpenRouterConfig>): OpenRouterConfig {
  const apiKey = String(process.env.OPENROUTER_API_KEY || "").trim();
  if (!apiKey && getAiProvider() === "openrouter") {
    throw new Error("Missing OPENROUTER_API_KEY (required when AI_PROVIDER=openrouter)");
  }
  const timeoutRaw = parseInt(process.env.OPENROUTER_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || "120000", 10);
  return {
    apiKey,
    chatModel:
      String(process.env.OPENROUTER_CHAT_MODEL || process.env.OPENROUTER_MODEL || "").trim() ||
      DEFAULT_CHAT_MODEL,
    embedModel:
      String(process.env.OPENROUTER_EMBED_MODEL || "").trim() || DEFAULT_EMBED_MODEL,
    embedDimensions: getEmbedDimensions(),
    timeoutMs: Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 600_000) : 120_000,
    siteUrl: String(process.env.OPENROUTER_HTTP_REFERER || process.env.APP_BASE_URL || "").trim() || undefined,
    siteName: String(process.env.OPENROUTER_X_TITLE || "OrigemLab").trim() || "OrigemLab",
    ...overrides,
  };
}

function buildHeaders(cfg: OpenRouterConfig): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${cfg.apiKey}`,
    "Content-Type": "application/json",
  };
  if (cfg.siteUrl) headers["HTTP-Referer"] = cfg.siteUrl;
  if (cfg.siteName) headers["X-Title"] = cfg.siteName;
  return headers;
}

export type OpenRouterChatOptions = {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
};

export async function openRouterChat(
  prompt: string,
  options: OpenRouterChatOptions = {},
  config?: Partial<OpenRouterConfig>,
): Promise<string> {
  const cfg = loadOpenRouterConfig(config);
  const timeoutMs = options.timeoutMs ?? cfg.timeoutMs;
  const model = options.model ?? cfg.chatModel;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: buildHeaders(cfg),
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: options.temperature ?? 0.2,
        max_tokens: options.maxTokens ?? 700,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OpenRouter chat ${res.status}: ${text.slice(0, 800)}`);
    }
    const json = JSON.parse(text) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return String(json.choices?.[0]?.message?.content || "").trim();
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") {
      throw new Error(`OpenRouter chat timeout após ${Math.round(timeoutMs / 1000)}s`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(t);
  }
}

function assertEmbeddingDims(emb: number[], expected: number, model: string): number[] {
  if (!Array.isArray(emb) || emb.length === 0) {
    throw new Error(`OpenRouter embed (${model}): empty embedding`);
  }
  if (emb.length !== expected) {
    throw new Error(
      `OpenRouter embed (${model}): expected ${expected} dims, got ${emb.length}. Set OPENROUTER_EMBED_MODEL to a 1024-d model (e.g. baai/bge-m3).`,
    );
  }
  return emb.map((x) => Number(x));
}

/** Embed one or many texts; returns one vector per input, each length === embedDimensions. */
export async function openRouterEmbed(
  input: string | string[],
  config?: Partial<OpenRouterConfig>,
): Promise<number[][]> {
  const cfg = loadOpenRouterConfig(config);
  const texts = Array.isArray(input) ? input : [input];
  if (texts.length === 0) return [];

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), cfg.timeoutMs);
  try {
    const body: Record<string, unknown> = {
      model: cfg.embedModel,
      input: texts.length === 1 ? texts[0] : texts,
      dimensions: cfg.embedDimensions,
    };
    const res = await fetch(`${OPENROUTER_BASE_URL}/embeddings`, {
      method: "POST",
      headers: buildHeaders(cfg),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`OpenRouter embed ${res.status}: ${text.slice(0, 800)}`);
    }
    const json = JSON.parse(text) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
    };
    const data = Array.isArray(json.data) ? json.data : [];
    if (data.length === 0) {
      throw new Error(`OpenRouter embed (${cfg.embedModel}): no data in response`);
    }
    // OpenAI order is usually by index; sort to be safe
    const sorted = [...data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((row) =>
      assertEmbeddingDims(row.embedding || [], cfg.embedDimensions, cfg.embedModel),
    );
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "AbortError") {
      throw new Error(`OpenRouter embed timeout após ${Math.round(cfg.timeoutMs / 1000)}s`);
    }
    throw e instanceof Error ? e : new Error(String(e));
  } finally {
    clearTimeout(t);
  }
}

export async function openRouterEmbedOne(
  input: string,
  config?: Partial<OpenRouterConfig>,
): Promise<number[]> {
  const rows = await openRouterEmbed(input, config);
  return rows[0] || [];
}
