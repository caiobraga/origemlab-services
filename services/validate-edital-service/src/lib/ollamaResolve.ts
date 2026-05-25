import { ollamaFetch } from "./ollamaHttp";

let resolvedBase: string | null = null;
let resolvedChatModel: string | null = null;

const CHAT_MODEL_PRIORITY = [
  "qwen2.5:3b-instruct",
  "llama3.2:3b",
  "llama3.2:1b",
  "gemma2:2b",
  "phi3.5",
  "tinyllama",
];

function normalizeBase(url: string): string {
  return String(url || "").trim().replace(/\/+$/, "");
}

function isRemoteElbUrl(url: string): boolean {
  return /\.elb\.amazonaws\.com/i.test(url) || /\.amazonaws\.com/i.test(url);
}

function candidateUrls(): string[] {
  const primary = normalizeBase(process.env.OLLAMA_BASE_URL || "");
  const localExplicit = normalizeBase(process.env.OLLAMA_BASE_URL_LOCAL || "");
  const preferLocal = String(process.env.OLLAMA_PREFER_LOCAL ?? "0").trim() === "1";

  const out: string[] = [];
  const push = (u: string) => {
    if (u && !out.includes(u)) out.push(u);
  };

  if (preferLocal) {
    push(localExplicit);
    push("http://127.0.0.1:11434");
    push("http://localhost:11434");
    push(primary);
  } else {
    push(primary);
    push(localExplicit);
    push("http://127.0.0.1:11434");
    push("http://localhost:11434");
  }
  return out;
}

/** Corrige typo comum: OLLAMA_MODEL=OLLAMA_CHAT_MODEL=qwen... */
export function parseConfiguredChatModel(): string {
  const raw = (process.env.OLLAMA_MODEL || process.env.OLLAMA_CHAT_MODEL || "gemma2:2b").trim();
  const cleaned = raw.replace(/^OLLAMA_CHAT_MODEL=/i, "").trim();
  return cleaned || "gemma2:2b";
}

async function fetchInstalledModels(baseUrl: string, timeoutMs = 8000): Promise<string[]> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await ollamaFetch(`${baseUrl}/api/tags`, { method: "GET", signal: controller.signal }, timeoutMs);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    return (data?.models || []).map((m) => String(m.name || m.model || "").trim()).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

function normalizeModelName(name: string): string {
  return String(name || "").trim().toLowerCase();
}

function matchInstalledModel(requested: string, installed: string[]): string | null {
  const req = normalizeModelName(requested);
  if (!req) return null;
  const list = installed.map((n) => ({ raw: n, norm: normalizeModelName(n) }));
  const exact = list.find((m) => m.norm === req);
  if (exact) return exact.raw;
  const reqBase = req.split(":")[0];
  const partial = list.find(
    (m) => m.norm === reqBase || m.norm.startsWith(`${reqBase}:`) || m.norm.startsWith(reqBase),
  );
  return partial?.raw ?? null;
}

function isEmbedModelName(name: string): boolean {
  const n = normalizeModelName(name);
  return n.includes("embed") || n.includes("mxbai") || n.includes("nomic-embed");
}

function pickChatModel(installed: string[], configured: string): string | null {
  const hit = matchInstalledModel(configured, installed);
  if (hit && !isEmbedModelName(hit)) return hit;
  for (const pref of CHAT_MODEL_PRIORITY) {
    const m = matchInstalledModel(pref, installed);
    if (m && !isEmbedModelName(m)) return m;
  }
  return installed.find((m) => !isEmbedModelName(m)) ?? null;
}

async function resolveOllamaModels(baseUrl: string): Promise<void> {
  const installed = await fetchInstalledModels(baseUrl);
  if (installed.length === 0) {
    throw new Error(`Ollama em ${baseUrl} respondeu mas não há modelos. Rode: ollama pull gemma2:2b`);
  }

  const configuredChat = parseConfiguredChatModel();
  const chat = pickChatModel(installed, configuredChat);
  if (!chat) {
    throw new Error(
      `Nenhum modelo de chat no Ollama (${baseUrl}). Instalados: ${installed.join(", ")}`,
    );
  }

  resolvedChatModel = chat;
  process.env.OLLAMA_MODEL = chat;
  process.env.OLLAMA_CHAT_MODEL = chat;

  if (normalizeModelName(chat) !== normalizeModelName(configuredChat)) {
    console.warn(`[validate-edital] OLLAMA_MODEL=${configuredChat} não encontrado — usando ${chat}`);
  }
  console.log(`[validate-edital] Ollama modelos: chat=${chat}`);
}

export async function initOllamaBaseUrl(): Promise<string> {
  if (resolvedBase) return resolvedBase;

  const configured = normalizeBase(process.env.OLLAMA_BASE_URL || "");
  const candidates = candidateUrls();

  for (const url of candidates) {
    const models = await fetchInstalledModels(url);
    if (models.length > 0) {
      resolvedBase = url;
      process.env.OLLAMA_BASE_URL = url;
      if (configured && url !== configured) {
        console.warn(`[validate-edital] Ollama configurado em ${configured} inacessível — usando ${url}`);
        if (isRemoteElbUrl(configured)) {
          console.warn("   Dica dev: OLLAMA_BASE_URL=http://127.0.0.1:11434 ou OLLAMA_PREFER_LOCAL=1");
        }
      } else {
        console.log(`[validate-edital] Ollama OK: ${url}`);
      }
      await resolveOllamaModels(url);
      return url;
    }
  }

  throw new Error(
    `Ollama inacessível (tentado: ${candidates.join(", ")}). Suba \`ollama serve\` ou ajuste OLLAMA_BASE_URL.`,
  );
}

export function getResolvedOllamaBaseUrl(): string {
  return resolvedBase || normalizeBase(process.env.OLLAMA_BASE_URL || "") || "http://127.0.0.1:11434";
}

export function getResolvedOllamaModel(): string {
  return resolvedChatModel || parseConfiguredChatModel();
}
