import { FIELD_KEYWORD_HINTS, PROCESS_EDITAL_FIELDS } from "./constants.mjs";

/** Lido em runtime (depois de loadEnv no main) — não usar no topo do módulo com ESM. */
function ollamaBaseUrl() {
  return (process.env.OLLAMA_BASE_URL || "http://localhost:11434").replace(/\/$/, "");
}

function chatModel() {
  return process.env.OLLAMA_CHAT_MODEL || "llama3.2:3b";
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
${plainChunk.slice(0, 12000)}
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
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: chatModel(),
          stream: false,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          options: { temperature: 0.1, num_predict: 1024 },
        }),
      });
      if (!res.ok) throw new Error(`Ollama chat: ${res.status} ${await res.text()}`);
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
        "[CONTEXTO PARA BUSCA — alinhado ao pipeline process-edital-info]",
        `Tipos de pergunta: ${enrichment.tipos_de_pergunta.join("; ") || "(não especificado)"}`,
        `Campos relacionados: ${enrichment.campos_relacionados.join(", ") || "(nenhum)"}`,
        `Perguntas exemplo: ${enrichment.perguntas_exemplo.join(" | ") || "(nenhuma)"}`,
        "",
        "[TRECHO DO EDITAL]",
      ].join("\n");

      const embeddingText = `${header}\n${plainChunk.trim()}`;

      return { embeddingText, enrichment, skipped: false };
    } catch (e) {
      lastErr = e;
      await sleep(300 * (attempt + 1));
    }
  }

  const errMsg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  console.warn(`      [enrich] falhou chunk ${chunkIndex}: ${errMsg}`);
  if (/memory|system memory|GiB|requires more/i.test(errMsg)) {
    console.warn(
      "      [enrich] Dica: modelo de chat grande demais para a RAM. Experimente: OLLAMA_CHAT_MODEL=llama3.2:3b (ou phi3:mini), ou ENRICH_CHUNKS=0",
    );
  }
  if (/404.*not found/i.test(errMsg)) {
    console.warn(
      `      [enrich] Dica: em ${ollamaBaseUrl()} faz pull do modelo: ollama pull ${chatModel()}`,
    );
  }
  return {
    embeddingText: plainChunk,
    enrichment: null,
    skipped: false,
    enrichFailed: true,
  };
}

export function enrichDelayMs() {
  return Math.max(0, parseInt(process.env.CHUNK_ENRICH_DELAY_MS || "50", 10) || 0);
}
