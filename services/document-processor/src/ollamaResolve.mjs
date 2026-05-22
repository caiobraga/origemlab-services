import { ollamaFetch } from "./ollamaHttp.mjs";
import { describeFetchError } from "./fetchError.mjs";

let resolvedBase = null;
let resolvedChatModel = null;
let resolvedEmbedModel = null;
let loggedModelHint = false;

const CHAT_MODEL_PRIORITY = [
  "qwen2.5:3b-instruct",
  "llama3.2:3b",
  "llama3.2:1b",
  "phi3.5",
  "phi3",
  "gemma3",
  "gemma2:2b",
  "tinyllama",
];

const EMBED_MODEL_PRIORITY = ["mxbai-embed-large", "nomic-embed-text"];

function normalizeBase(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

function candidateUrls() {
  const primary = normalizeBase(process.env.OLLAMA_BASE_URL);
  const local = normalizeBase(process.env.OLLAMA_BASE_URL_LOCAL || "http://127.0.0.1:11434");
  const out = [];
  const push = (u) => {
    if (u && !out.includes(u)) out.push(u);
  };
  push(primary);
  push(local);
  push("http://127.0.0.1:11434");
  push("http://localhost:11434");
  return out;
}

async function fetchInstalledModels(baseUrl, timeoutMs = 8000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await ollamaFetch(`${baseUrl}/api/tags`, { method: "GET", signal: controller.signal }, timeoutMs);
    if (!res.ok) return [];
    const data = await res.json();
    return (data?.models || []).map((m) => String(m.name || m.model || "").trim()).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

async function probeOllama(baseUrl, timeoutMs = 8000) {
  const models = await fetchInstalledModels(baseUrl, timeoutMs);
  return models.length > 0;
}

function normalizeModelName(name) {
  return String(name || "").trim().toLowerCase();
}

/** Aceita `mxbai-embed-large` quando só existe `mxbai-embed-large:latest`. */
export function matchInstalledModel(requested, installed) {
  const req = normalizeModelName(requested);
  if (!req) return null;
  const list = installed.map((n) => ({ raw: n, norm: normalizeModelName(n) }));
  const exact = list.find((m) => m.norm === req);
  if (exact) return exact.raw;
  const reqBase = req.split(":")[0];
  const partial = list.find((m) => m.norm === reqBase || m.norm.startsWith(`${reqBase}:`) || m.norm.startsWith(reqBase));
  if (partial) return partial.raw;
  return null;
}

function isEmbedModelName(name) {
  const n = normalizeModelName(name);
  return n.includes("embed") || n.includes("mxbai") || n.includes("nomic-embed");
}

function pickChatModel(installed, configured) {
  const hit = matchInstalledModel(configured, installed);
  if (hit && !isEmbedModelName(hit)) return hit;
  for (const pref of CHAT_MODEL_PRIORITY) {
    const m = matchInstalledModel(pref, installed);
    if (m && !isEmbedModelName(m)) return m;
  }
  return installed.find((m) => !isEmbedModelName(m)) || null;
}

function pickEmbedModel(installed, configured) {
  const hit = matchInstalledModel(configured, installed);
  if (hit) return hit;
  for (const pref of EMBED_MODEL_PRIORITY) {
    const m = matchInstalledModel(pref, installed);
    if (m) return m;
  }
  return installed.find((m) => isEmbedModelName(m)) || null;
}

async function resolveOllamaModels(baseUrl) {
  const installed = await fetchInstalledModels(baseUrl);
  if (installed.length === 0) {
    throw new Error(`Ollama em ${baseUrl} respondeu mas não há modelos. Rode: ollama pull qwen2.5:3b-instruct-q4_K_M`);
  }

  const configuredChat =
    process.env.OLLAMA_CHAT_MODEL || process.env.OLLAMA_MODEL || "gemma2:2b";
  const configuredEmbed = process.env.OLLAMA_EMBED_MODEL || "mxbai-embed-large";

  const chat = pickChatModel(installed, configuredChat);
  const embed = pickEmbedModel(installed, configuredEmbed);

  if (!chat) {
    throw new Error(
      `Nenhum modelo de chat no Ollama. Instalados: ${installed.join(", ")}. Sugestão: ollama pull qwen2.5:3b-instruct-q4_K_M`,
    );
  }
  if (!embed) {
    throw new Error(
      `Nenhum modelo de embedding no Ollama. Sugestão: ollama pull mxbai-embed-large`,
    );
  }

  resolvedChatModel = chat;
  resolvedEmbedModel = embed;
  process.env.OLLAMA_CHAT_MODEL = chat;
  process.env.OLLAMA_MODEL = chat;
  process.env.OLLAMA_EMBED_MODEL = embed;

  if (normalizeModelName(chat) !== normalizeModelName(configuredChat)) {
    console.warn(
      `[document-processor] OLLAMA_CHAT_MODEL=${configuredChat} não encontrado — usando ${chat}`,
    );
    console.warn(`   Instalados: ${installed.join(", ")}`);
  }
  if (normalizeModelName(embed) !== normalizeModelName(configuredEmbed)) {
    console.warn(
      `[document-processor] OLLAMA_EMBED_MODEL=${configuredEmbed} não encontrado — usando ${embed}`,
    );
  }
  console.log(`[document-processor] Ollama modelos: chat=${chat} embed=${embed}`);
}

export function getOllamaChatModel() {
  return resolvedChatModel || process.env.OLLAMA_CHAT_MODEL || process.env.OLLAMA_MODEL || "llama3.2:1b";
}

export function getOllamaEmbedModel() {
  return resolvedEmbedModel || process.env.OLLAMA_EMBED_MODEL || "mxbai-embed-large";
}

/** Loga dica de pull/modelo no máximo uma vez por processo. */
export function logOllamaModelHintOnce(message) {
  if (loggedModelHint) return;
  loggedModelHint = true;
  console.warn(message);
}

/**
 * Escolhe URL Ollama acessível (dev local: NLB AWS costuma dar ENETUNREACH).
 * Define process.env.OLLAMA_BASE_URL para o restante do pipeline.
 */
export async function initOllamaBaseUrl() {
  if (resolvedBase) return resolvedBase;

  const configured = normalizeBase(process.env.OLLAMA_BASE_URL);
  const candidates = candidateUrls();

  for (const url of candidates) {
    if (await probeOllama(url)) {
      resolvedBase = url;
      process.env.OLLAMA_BASE_URL = url;
      if (configured && url !== configured) {
        console.warn(
          `[document-processor] Ollama configurado em ${configured} está inacessível — usando ${url}`,
        );
        console.warn(
          "   Dev local: use OLLAMA_BASE_URL=http://localhost:11434 ou OLLAMA_BASE_URL_LOCAL=http://localhost:11434 no .env",
        );
      } else {
        console.log(`[document-processor] Ollama OK: ${url}`);
      }
      await resolveOllamaModels(url);
      return url;
    }
  }

  const detail = candidates.join(", ");
  throw new Error(
    `Ollama inacessível (tentado: ${detail}). Suba \`ollama serve\` localmente ou ajuste OLLAMA_BASE_URL / OLLAMA_BASE_URL_LOCAL.`,
  );
}

export function getOllamaBaseUrl() {
  return resolvedBase || normalizeBase(process.env.OLLAMA_BASE_URL) || "http://127.0.0.1:11434";
}
