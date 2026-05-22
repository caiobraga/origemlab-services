import { FIELD_KEYWORD_HINTS, PROCESS_EDITAL_FIELDS } from "./constants.mjs";
import { describeFetchError, isUnreachableNetworkError } from "./fetchError.mjs";
import { ollamaFetch } from "./ollamaHttp.mjs";
import { getOllamaBaseUrl, getOllamaChatModel, logOllamaModelHintOnce } from "./ollamaResolve.mjs";

const CONTEXTO_BUSCA_PREFIX = "[CONTEXTO PARA BUSCA — alinhado ao pipeline process-edital-info]";

/**
 * A partir do `content` gravado no document (cabeçalho + [TRECHO DO EDITAL] + texto), devolve só a parte
 * usada para embedding de retrieval / backfill.
 */
export function retrievalEmbeddingInputFromChunkContent(content) {
  const s = String(content || "").trim();
  if (!s) return "";
  const marker = "[TRECHO DO EDITAL]";
  const i = s.indexOf(marker);
  if (i > 0) return s.slice(0, i).trim();
  return s.slice(0, Math.min(s.length, 4096));
}

function ollamaBaseUrl() {
  return getOllamaBaseUrl();
}

function enrichChatTimeoutMs() {
  const n = parseInt(process.env.OLLAMA_CHAT_TIMEOUT_MS || process.env.OLLAMA_TIMEOUT_MS || "120000", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 600_000) : 120_000;
}

function enrichMaxInputChars() {
  const n = parseInt(process.env.ENRICH_MAX_INPUT_CHARS || "6000", 10);
  return Number.isFinite(n) && n > 500 ? Math.min(n, 12000) : 6000;
}

function enrichNumPredict() {
  const n = parseInt(process.env.ENRICH_NUM_PREDICT || "512", 10);
  return Number.isFinite(n) && n > 64 ? Math.min(n, 2048) : 512;
}

function chatModel() {
  return getOllamaChatModel();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseJsonLoose(text) {
  const t = String(text || "").trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : t;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Pede ao modelo uma camada de contexto para melhorar o embedding/RAG:
 * que tipos de pergunta o trecho responde + exemplos + campos do pipeline processEditalInfo.
 */
export async function enrichChunkForRetrieval(plainChunk, { chunkIndex = 0 } = {}) {
  const enrichEnabled = String(process.env.ENRICH_CHUNKS ?? "1").trim();
  if (enrichEnabled === "0" || enrichEnabled.toLowerCase() === "false") {
    return {
      embeddingText: plainChunk,
      embeddingRetrievalText: plainChunk,
      enrichment: null,
      skipped: true,
    };
  }

  const fieldsBlock = PROCESS_EDITAL_FIELDS.map((f) => `- ${f}: ${FIELD_KEYWORD_HINTS[f] || ""}`).join("\n");

  const system = `És um assistente técnico para indexação de editais brasileiros (fomento, bolsas, chamadas públicas).
Analisa só o TRECHO fornecido e devolve JSON estrito (sem markdown fora do JSON).`;

  const user = `Campos que o nosso pipeline extrai dos PDFs (api process-edital-info):
${fieldsBlock}

TRECHO_DO_EDITAL (índice ${chunkIndex}):
"""
${plainChunk.slice(0, Math.min(plainChunk.length, enrichMaxInputChars()))}
"""

Tarefa:
1) Lista "tipos_de_pergunta": frases curtas sobre que perguntas dos utilizadores este trecho ajuda a responder (ex.: prazos de inscrição, valores, elegibilidade).
2) Lista "campos_relacionados": escolhe de PROCESS_EDITAL_FIELDS os mais relevantes para este trecho (0 a 9 strings, nomes exatos).
3) Lista "perguntas_exemplo": 3 a 8 perguntas naturais que faríamos ao RAG sobre este trecho (como em pesquisa por edital).

Resposta APENAS neste formato JSON:
{"tipos_de_pergunta":["..."],"campos_relacionados":["valor_projeto"],"perguntas_exemplo":["..."]}`;

  const url = `${ollamaBaseUrl()}/api/chat`;
  const maxRetries = Math.max(0, parseInt(process.env.OLLAMA_CHAT_RETRIES || "2", 10) || 2);

  let lastErr;
  const chatTimeoutMs = enrichChatTimeoutMs();
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), chatTimeoutMs);
      let res;
      try {
        res = await ollamaFetch(
          url,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              model: chatModel(),
              stream: false,
              messages: [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              options: { temperature: 0.1, num_predict: enrichNumPredict() },
            }),
            signal: controller.signal,
          },
          chatTimeoutMs,
        );
      } finally {
        clearTimeout(t);
      }
      if (!res.ok) throw new Error(`Ollama chat: ${res.status} ${(await res.text()).slice(0, 500)}`);
      const data = await res.json();
      const msg = data?.message?.content ?? data?.response ?? "";
      const parsed = parseJsonLoose(msg);
      if (!parsed || typeof parsed !== "object") throw new Error("JSON inválido do modelo");

      const tipos = Array.isArray(parsed.tipos_de_pergunta) ? parsed.tipos_de_pergunta.map(String) : [];
      const campos = Array.isArray(parsed.campos_relacionados) ? parsed.campos_relacionados.map(String) : [];
      const perguntas = Array.isArray(parsed.perguntas_exemplo) ? parsed.perguntas_exemplo.map(String) : [];

      const enrichment = {
        tipos_de_pergunta: tipos.slice(0, 20),
        campos_relacionados: campos.filter((c) => PROCESS_EDITAL_FIELDS.includes(c)).slice(0, 9),
        perguntas_exemplo: perguntas.slice(0, 12),
      };

      const header = [
        CONTEXTO_BUSCA_PREFIX,
        `Tipos de pergunta: ${enrichment.tipos_de_pergunta.join("; ") || "(não especificado)"}`,
        `Campos relacionados: ${enrichment.campos_relacionados.join(", ") || "(nenhum)"}`,
        `Perguntas exemplo: ${enrichment.perguntas_exemplo.join(" | ") || "(nenhuma)"}`,
        "",
        "[TRECHO DO EDITAL]",
      ].join("\n");

      const embeddingText = `${header}\n${plainChunk.trim()}`;
      const embeddingRetrievalText = [
        CONTEXTO_BUSCA_PREFIX,
        `Tipos de pergunta: ${enrichment.tipos_de_pergunta.join("; ") || "(não especificado)"}`,
        `Campos relacionados: ${enrichment.campos_relacionados.join(", ") || "(nenhum)"}`,
        `Perguntas exemplo: ${enrichment.perguntas_exemplo.join(" | ") || "(nenhuma)"}`,
      ].join("\n");

      return { embeddingText, embeddingRetrievalText, enrichment, skipped: false };
    } catch (e) {
      lastErr = e;
      if (isUnreachableNetworkError(e)) break;
      await sleep(300 * (attempt + 1));
    }
  }

  const errMsg =
    lastErr instanceof Error
      ? lastErr.message === "fetch failed" || lastErr.message?.startsWith("fetch failed")
        ? `Ollama chat (${ollamaBaseUrl()}): ${describeFetchError(lastErr)}`
        : lastErr.message
      : String(lastErr);
  if (chunkIndex === 0 || chunkIndex % 10 === 0) {
    console.warn(`      [enrich] falhou chunk ${chunkIndex}: ${errMsg}`);
  }
  if (chunkIndex === 0 && isUnreachableNetworkError(lastErr)) {
    logOllamaModelHintOnce(
      `      [enrich] Ollama inacessível em ${ollamaBaseUrl()} — verifique OLLAMA_BASE_URL / OLLAMA_BASE_URL_LOCAL`,
    );
  }
  if (/memory|system memory|GiB|requires more/i.test(errMsg)) {
    logOllamaModelHintOnce(
      "      [enrich] Dica: modelo de chat grande demais para a RAM. Use OLLAMA_CHAT_MODEL=qwen2.5:3b-instruct-q4_K_M ou ENRICH_CHUNKS=0",
    );
  }
  if (/404.*not found|model.*not found/i.test(errMsg)) {
    logOllamaModelHintOnce(
      `      [enrich] Modelo de chat ausente. Ajuste OLLAMA_CHAT_MODEL no .env ou: ollama pull ${chatModel()}`,
    );
  }
  return {
    embeddingText: plainChunk,
    embeddingRetrievalText: plainChunk,
    enrichment: null,
    skipped: false,
    enrichFailed: true,
  };
}

export function enrichDelayMs() {
  return Math.max(0, parseInt(process.env.CHUNK_ENRICH_DELAY_MS || "0", 10) || 0);
}

export function enrichConcurrency() {
  const n = parseInt(process.env.ENRICH_CONCURRENCY || "4", 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(16, n)) : 4;
}

/** 0 = sem limite; só enriquece os primeiros N chunks (resto vai como texto puro). */
export function enrichMaxChunksPerPdf() {
  const n = parseInt(process.env.ENRICH_MAX_CHUNKS_PER_PDF || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
