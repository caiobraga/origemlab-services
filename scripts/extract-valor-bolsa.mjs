#!/usr/bin/env node
/**
 * Extrai o valor mensal por bolsa (`valor_bolsa`) de editais que citam bolsa e têm PDF processado.
 * Usa só os trechos já indexados em `documents` (metadata.edital_id). Um valor só é gravado se
 * o trecho de evidência aparecer literalmente nos trechos e contiver os mesmos números do valor.
 *
 * Uso (a partir da raiz do monorepo):
 *   ./scripts/run-with-nvm.sh node origemlab-services/scripts/extract-valor-bolsa.mjs --out <arquivo.json>
 *   ./scripts/run-with-nvm.sh node origemlab-services/scripts/extract-valor-bolsa.mjs --write --out <arquivo.json>
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const envFile = process.env.ENV_FILE || resolve(__dir, "../.env");

function loadEnvFile(f) {
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
}
loadEnvFile(envFile);

const WRITE = process.argv.includes("--write");
const outIdx = process.argv.indexOf("--out");
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : null;
const MODEL = process.env.OPENROUTER_CHAT_MODEL || "google/gemini-2.5-flash";
const CONCURRENCY = Number(process.env.VALOR_BOLSA_CONCURRENCY || "4");
const PRICE_IN = 0.3 / 1e6; // US$ por token de entrada (gemini-2.5-flash)
const PRICE_OUT = 2.5 / 1e6; // US$ por token de saída

const SB_URL = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const OR_KEY = process.env.OPENROUTER_API_KEY;
if (!SB_URL || !SB_KEY || !OR_KEY) {
  console.error("Defina SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e OPENROUTER_API_KEY em origemlab-services/.env");
  process.exit(1);
}

async function sb(path, init = {}) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status} em ${path.slice(0, 60)}: ${await res.text()}`);
  return init.method === "PATCH" ? null : res.json();
}

async function fetchAllEditais() {
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await sb(
      `editais?select=id,fonte,titulo,numero,valor_projeto,sobre_programa,descricao,criterios_elegibilidade,timeline_estimada,valor_bolsa,informacoes_extracao_evidence&order=id&limit=500&offset=${offset}`,
    );
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows;
}

const BOLSA_RE = /bolsa/i;
const hasBolsa = (e) =>
  BOLSA_RE.test(
    [e.titulo, e.valor_projeto, e.sobre_programa, e.descricao, e.criterios_elegibilidade, e.timeline_estimada]
      .map((v) => String(v || ""))
      .join(" "),
  );

async function fetchChunks(editalId) {
  const rows = await sb(
    `documents?select=content&metadata->>edital_id=eq.${editalId}&content=ilike.*bolsa*&limit=300`,
  );
  const score = (c) =>
    (/R\$\s*\d/.test(c) ? 4 : 0) + (/mensal|por mês|ao mês/i.test(c) ? 3 : 0) + (/ATP|bolsa/i.test(c) ? 1 : 0);
  const ranked = rows
    .map((r) => r.content || "")
    .sort((a, b) => score(b) - score(a))
    .slice(0, 10);
  let out = "";
  for (const c of ranked) {
    if (out.length + c.length > 12000) break;
    out += `\n---\n${c}`;
  }
  return out;
}

function buildPrompt(contexto) {
  return `Você extrai dados de editais de fomento brasileiros.
Pergunta: este edital define o valor mensal pago a cada bolsa? Se sim, qual é?

Regras:
- Use somente os trechos abaixo. Não use conhecimento externo.
- Se o edital só remeter a uma tabela ou portaria sem escrever o valor, responda null.
- Se houver mais de uma modalidade de bolsa com valor, junte num texto curto, ex.: "ATP-B: R$ 560,00/mês; ATP-A: R$ 700,00/mês".
- "evidencia" deve ser um trecho copiado literalmente de um dos trechos (até 220 caracteres) que contenha o valor.

Responda somente JSON: {"valor_bolsa": string|null, "evidencia": string|null}

TRECHOS:${contexto}`;
}

function parseJsonLoose(text) {
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b < 0) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();

async function extractOne(edital) {
  const contexto = await fetchChunks(edital.id);
  if (!contexto.trim()) return { edital, status: "sem_trechos", costUsd: 0 };

  let res;
  for (let tentativa = 0; ; tentativa++) {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OR_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "origemlab valor_bolsa",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: buildPrompt(contexto) }],
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      }),
    });
    // 429/503 do provedor são transitórios: espera e tenta de novo (até 3 tentativas extras).
    if ((res.status !== 429 && res.status !== 503) || tentativa >= 3) break;
    await new Promise((r) => setTimeout(r, 10000 * (tentativa + 1)));
  }
  if (!res.ok) return { edital, status: "erro_llm", erro: `${res.status} ${(await res.text()).slice(0, 200)}`, costUsd: 0 };
  const data = await res.json();
  const costUsd =
    (data.usage?.prompt_tokens || 0) * PRICE_IN + (data.usage?.completion_tokens || 0) * PRICE_OUT;
  const parsed = parseJsonLoose(data.choices?.[0]?.message?.content || "");
  if (!parsed) return { edital, status: "json_invalido", costUsd };

  // Modalidades sem valor voltam como "...: null"; descarta esses trechos e mantém os que têm R$.
  const valor =
    typeof parsed.valor_bolsa === "string"
      ? parsed.valor_bolsa
          .split(";")
          .filter((s) => !/\bnull\b/i.test(s))
          .join(";")
          .trim() || null
      : null;
  const evidencia = typeof parsed.evidencia === "string" ? parsed.evidencia.trim() : null;
  if (!valor) return { edital, status: "sem_valor", costUsd };
  if (!/R\$\s*\d/.test(valor)) return { edital, status: "rejeitado_sem_R$", valor, costUsd };
  if (!evidencia || !norm(contexto).includes(norm(evidencia)))
    return { edital, status: "rejeitado_evidencia_ausente", valor, evidencia, costUsd };
  const numeros = valor.match(/\d{1,3}(?:\.\d{3})*,\d{2}/g) || [];
  if (numeros.some((n) => !evidencia.includes(n)))
    return { edital, status: "rejeitado_numero_diferente", valor, evidencia, costUsd };
  // Prêmios e pagamentos em parcela única também citam bolsa e R$; só valor mensal entra.
  if (!/mês|mensal|mensais/i.test(`${valor} ${evidencia}`))
    return { edital, status: "rejeitado_nao_mensal", valor, evidencia, costUsd };
  return { edital, status: "ok", valor, evidencia, costUsd };
}

async function persist(result) {
  const merged = { ...(result.edital.informacoes_extracao_evidence || {}) };
  merged.valor_bolsa = { source: "extract-valor-bolsa", snippet: result.evidencia };
  await sb(`editais?id=eq.${result.edital.id}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ valor_bolsa: result.valor, informacoes_extracao_evidence: merged }),
  });
}

async function main() {
  const editais = await fetchAllEditais();
  // PostgREST devolve no máximo 1000 linhas por requisição; sem paginar, editais ficam de fora.
  const pdfRows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await sb(`edital_pdfs?select=edital_id&is_processed=eq.true&order=id&limit=1000&offset=${offset}`);
    pdfRows.push(...page);
    if (page.length < 1000) break;
  }
  const comPdf = new Set(pdfRows.map((p) => p.edital_id).filter(Boolean));

  const candidatos = editais.filter((e) => comPdf.has(e.id) && hasBolsa(e) && !e.valor_bolsa);
  console.log(`editais: ${editais.length} | com PDF processado e menção a bolsa (sem valor_bolsa): ${candidatos.length}`);
  console.log(`modelo: ${MODEL} | modo: ${WRITE ? "GRAVAR" : "dry-run"}`);

  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < candidatos.length) {
      const e = candidatos[idx++];
      try {
        results.push(await extractOne(e));
      } catch (err) {
        results.push({ edital: e, status: "erro", erro: String(err.message || err), costUsd: 0 });
      }
      const r = results[results.length - 1];
      console.log(`[${results.length}/${candidatos.length}] ${r.status.padEnd(28)} ${(r.edital.fonte || "").padEnd(12)} ${String(r.valor || "").slice(0, 70)}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const custo = results.reduce((s, r) => s + (r.costUsd || 0), 0);
  const ok = results.filter((r) => r.status === "ok");
  const porStatus = results.reduce((m, r) => {
    m[r.status] = (m[r.status] || 0) + 1;
    return m;
  }, {});
  console.log(`\nresumo: ${JSON.stringify(porStatus)}`);
  console.log(`custo estimado desta rodada: US$ ${custo.toFixed(4)}`);

  if (OUT) {
    writeFileSync(
      OUT,
      JSON.stringify(
        results.map((r) => ({
          id: r.edital.id,
          fonte: r.edital.fonte,
          titulo: r.edital.titulo,
          status: r.status,
          valor: r.valor || null,
          evidencia: r.evidencia || null,
          erro: r.erro || null,
        })),
        null,
        2,
      ),
    );
    console.log(`resultados salvos em ${OUT}`);
  }

  if (WRITE) {
    for (const r of ok) await persist(r);
    console.log(`gravados: ${ok.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
