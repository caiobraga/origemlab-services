#!/usr/bin/env node
/**
 * Extrai o perfil de execução (`perfil_execucao`) dos editais publicados (editais_corretos):
 * duração, valor por projeto, nº de parcelas, TransfereGov, obra, CLT, Lei 14.133 e natureza P&D.
 * São os dados que os critérios de seleção do match projeto × editais precisam.
 *
 * Usa só os trechos já indexados em `documents` (metadata.edital_id) + textos do edital.
 * Cada campo só é gravado se vier com um trecho de evidência que aparece literalmente no contexto;
 * sem evidência o campo fica null (o match trata como "não informado" e não exclui).
 *
 * Uso (a partir da raiz do monorepo):
 *   ./scripts/run-with-nvm.sh node origemlab-services/scripts/extract-perfil-execucao.mjs --limit 10 --out <arquivo.json>
 *   ./scripts/run-with-nvm.sh node origemlab-services/scripts/extract-perfil-execucao.mjs --write --out <arquivo.json>
 * Flags: --write grava; --force refaz quem já tem perfil; --limit N; --only <edital_id>.
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

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : null;
};
const WRITE = flag("--write");
const FORCE = flag("--force");
const OUT = opt("--out");
const LIMIT = Number(opt("--limit") || 0) || Infinity;
const ONLY = opt("--only");
// --ids a,b,c (ou arquivo com um id por linha): reprocessa só esses editais.
const IDS_ARG = opt("--ids");
const IDS = IDS_ARG
  ? new Set(
      (existsSync(IDS_ARG) ? readFileSync(IDS_ARG, "utf8") : IDS_ARG)
        .split(/[\s,]+/)
        .map((x) => x.trim())
        .filter(Boolean),
    )
  : null;
const MODEL = process.env.PERFIL_EXECUCAO_MODEL || "google/gemini-2.5-flash";
const CONCURRENCY = Number(process.env.PERFIL_EXECUCAO_CONCURRENCY || "4");
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

async function fetchCandidatos() {
  // Antes da migration (dry-run), a coluna ainda não existe: lê sem ela.
  let cols = "id,fonte,titulo,numero,valor_projeto,sobre_programa,criterios_elegibilidade,perfil_execucao";
  try {
    await sb(`editais_corretos?select=perfil_execucao&limit=1`);
  } catch (e) {
    if (WRITE) throw new Error(`Aplique sql/20261110_editais_perfil_execucao.sql antes de --write (${e.message})`);
    cols = cols.replace(",perfil_execucao", "");
  }
  const rows = [];
  for (let offset = 0; ; offset += 500) {
    const page = await sb(`editais_corretos?select=${cols}&order=id&limit=500&offset=${offset}`);
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows.filter((e) => (ONLY ? e.id === ONLY : IDS ? IDS.has(e.id) : FORCE || !e.perfil_execucao)).slice(0, LIMIT);
}

/** Termos que costumam aparecer perto de cada critério; ranqueiam os chunks do edital. */
const TERMOS = [
  [/prazo de execu|vig[êe]ncia|dura[çc][ãa]o|\b\d{1,2}\s*\(?[a-z ]*\)?\s*meses\b/i, 4],
  [/parcela|desembols|libera[çc][ãa]o (dos )?recursos|aporte|cronograma de desembolso/i, 4],
  [/transferegov|plataforma \+?brasil|siconv/i, 6],
  [/\bobras?\b|constru[çc][ãa]o civil|edifica[çc]|reforma|infraestrutura f[íi]sica/i, 3],
  [/\bclt\b|celetista|consolida[çc][ãa]o das leis do trabalho|contrata[çc][ãa]o de pessoal|despesas? com pessoal/i, 4],
  [/14\.?133|lei de licita|licita[çc][ãa]o/i, 4],
  [/valor (m[áa]ximo|global|total)|R\$\s*\d/i, 2],
  [/pesquisa|inova[çc][ãa]o|desenvolvimento tecnol|P&D|PD&I/i, 1],
  [/itens financi[áa]veis|despesas (de capital|correntes)|n[ãa]o ser[ãa]o financiad|vedad/i, 3],
];

async function fetchContexto(edital) {
  const rows = await sb(`documents?select=content&metadata->>edital_id=eq.${edital.id}&limit=400`);
  const score = (c) => TERMOS.reduce((s, [re, w]) => s + (re.test(c) ? w : 0), 0);
  const ranked = rows
    .map((r) => String(r.content || ""))
    .filter((c) => c.trim())
    .map((c) => [c, score(c)])
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([c]) => c);
  const base = [
    edital.sobre_programa ? `SOBRE O PROGRAMA: ${edital.sobre_programa}` : "",
    edital.criterios_elegibilidade ? `CRITÉRIOS: ${String(edital.criterios_elegibilidade).slice(0, 3000)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  let out = base;
  for (const c of ranked) {
    if (out.length + c.length > 18000) break;
    out += `\n---\n${c}`;
  }
  return { texto: out, chunks: rows.length };
}

function buildPrompt(edital, contexto) {
  return `Você extrai dados de editais de fomento brasileiros para uma fundação de apoio que vai gerir o projeto.
Edital: ${edital.numero || "s/n"} — ${edital.titulo} (${edital.fonte || "?"})

Responda sobre UM PROJETO apoiado por este edital, usando somente os trechos abaixo:
- prazo_execucao_meses: duração máxima de execução do projeto, em meses (inteiro). Não confunda com prazo de inscrição ou vigência do edital. Se o texto der anos, converta.
- valor_global_projeto: valor máximo que UM projeto pode receber, em reais (número, sem R$). Não use o orçamento total da chamada nem o valor mensal de uma bolsa.
- num_parcelas: em quantas parcelas/aportes/desembolsos o recurso é liberado ao projeto (inteiro).
- transferegov: true se a execução, o convênio ou a prestação de contas for pela plataforma TransfereGov (ex-Plataforma +Brasil/SICONV); false se o texto disser que a execução/prestação de contas é por outro sistema. O sistema de submissão de propostas não conta.
- exige_obra: true só se o OBJETO do projeto for construir (ex.: "construção de laboratório/centro/sede" como entrega obrigatória). Edital que apenas PERMITE obras, reformas, adaptações ou "pequenas obras" entre os itens financiáveis não exige obra: use false. false também se vedar obras.
- clt: true só se os itens financiáveis com recursos do projeto incluírem salários/encargos de pessoal CLT; false se vedar despesas com pessoal ou só prever bolsas/serviços de terceiros. Exigir que o coordenador/equipe tenha vínculo empregatício (celetista ou estatutário) com a instituição NÃO conta, nem citar trabalhadores CLT da empresa: nesses casos use null.
- lei_14133_integral: true só se o texto exigir que as compras e contratações do projeto sigam a Lei 14.133/2021 (licitação pública); false se houver regime próprio (ex.: Decreto 8.240, Lei 8.958, Lei 10.973, compras de fundação de apoio). Frases genéricas como "o presente edital regula-se pela Lei 14.133", "no que couber", "impedimento de licitar" ou princípio de vinculação ao edital NÃO contam: use null.
- pd_inovacao: true se o objeto for um projeto de pesquisa, desenvolvimento tecnológico ou inovação; false se for outro (bolsas individuais de formação como IC/mestrado/doutorado, seleção de pareceristas ou equipe, evento, capacitação, extensão, prêmio, infraestrutura sem pesquisa).

Regras:
- Use null para o que os trechos não disserem. Não use conhecimento externo e não deduza do nome do órgão.
- Para cada campo não-null, coloque em "evidencias" um trecho copiado literalmente dos trechos (até 220 caracteres) que sustente a resposta.

Responda somente JSON:
{"prazo_execucao_meses": number|null, "valor_global_projeto": number|null, "num_parcelas": number|null, "transferegov": boolean|null, "exige_obra": boolean|null, "clt": boolean|null, "lei_14133_integral": boolean|null, "pd_inovacao": boolean|null, "evidencias": {"<campo>": "trecho"}}

TRECHOS:
${contexto}`;
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

const CAMPOS_NUM = { prazo_execucao_meses: [1, 240], valor_global_projeto: [1000, 5e9], num_parcelas: [1, 60] };
const CAMPOS_BOOL = ["transferegov", "exige_obra", "clt", "lei_14133_integral", "pd_inovacao"];

/**
 * Trava contra os falsos positivos vistos na 1ª rodada (2026-11-10): o modelo marcava "exige"
 * quando o edital só permite, e "14.133 integral" com citação genérica da lei. Se a evidência
 * de um `true` bate aqui, o campo vira null (não exclui o edital no match).
 */
const TRUE_FRACO = {
  exige_obra: /poder[ãa]o|poder[áa]|permitid|pequenas obras|reforma|adapta|recupera|conserva|moderniza|apoi[áa]ve|financi[áa]ve|exemplos|tais como|despesas? (de capital|com)|investimentos fixos/i,
  lei_14133_integral: /regula-se|art\.?\s*5º|no que couber|impedid|impedimento de licitar|vincula[çc][ãa]o ao edital|em conformidade com/i,
  clt: /v[íi]nculo (empregat[íi]cio|funcional|celetista|trabalhista) (efetivo|permanente|com a institui)|ter v[íi]nculo|possuir v[íi]nculo|comprovar v[íi]nculo|poder[ãa]o receber bolsa/i,
};

/** Mantém só campos com tipo certo, faixa plausível e evidência literal no contexto. */
function sanitize(parsed, contexto) {
  const ctx = norm(contexto);
  const ev = parsed?.evidencias && typeof parsed.evidencias === "object" ? parsed.evidencias : {};
  const out = { evidencias: {} };
  const rejeitados = [];
  const aceita = (campo) => {
    const trecho = typeof ev[campo] === "string" ? ev[campo].trim() : "";
    if (trecho && ctx.includes(norm(trecho))) {
      out.evidencias[campo] = trecho.slice(0, 240);
      return true;
    }
    rejeitados.push(campo);
    return false;
  };
  for (const [campo, [min, max]] of Object.entries(CAMPOS_NUM)) {
    const n = Number(parsed?.[campo]);
    out[campo] = parsed?.[campo] != null && Number.isFinite(n) && n >= min && n <= max && aceita(campo) ? Math.round(n) : null;
  }
  for (const campo of CAMPOS_BOOL) {
    out[campo] = typeof parsed?.[campo] === "boolean" && aceita(campo) ? parsed[campo] : null;
    if (out[campo] === true && TRUE_FRACO[campo]?.test(out.evidencias[campo] || "")) {
      out[campo] = null;
      delete out.evidencias[campo];
      rejeitados.push(`${campo}:evidencia_fraca`);
    }
  }
  out.extraido_em = new Date().toISOString();
  return { perfil: out, rejeitados };
}

async function extractOne(edital) {
  const { texto, chunks } = await fetchContexto(edital);
  if (!texto.trim()) return { edital, status: "sem_trechos", costUsd: 0 };

  let res;
  for (let tentativa = 0; ; tentativa++) {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OR_KEY}`,
        "Content-Type": "application/json",
        "X-Title": "origemlab perfil_execucao",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: buildPrompt(edital, texto) }],
        temperature: 0,
        max_tokens: 2500,
        response_format: { type: "json_object" },
      }),
    });
    // 429/503 do provedor são transitórios: espera e tenta de novo (até 3 tentativas extras).
    if ((res.status !== 429 && res.status !== 503) || tentativa >= 3) break;
    await new Promise((r) => setTimeout(r, 10000 * (tentativa + 1)));
  }
  if (!res.ok) return { edital, status: "erro_llm", erro: `${res.status} ${(await res.text()).slice(0, 200)}`, costUsd: 0 };
  const data = await res.json();
  const costUsd = (data.usage?.prompt_tokens || 0) * PRICE_IN + (data.usage?.completion_tokens || 0) * PRICE_OUT;
  const parsed = parseJsonLoose(data.choices?.[0]?.message?.content || "");
  if (!parsed) return { edital, status: "json_invalido", costUsd };
  const { perfil, rejeitados } = sanitize(parsed, texto);
  const preenchidos = Object.keys(perfil.evidencias).length;
  return { edital, status: preenchidos ? "ok" : "sem_dados", perfil, rejeitados, chunks, costUsd };
}

async function persist(result) {
  const body = JSON.stringify({ perfil_execucao: result.perfil });
  for (const tabela of ["editais", "editais_corretos"]) {
    await sb(`${tabela}?id=eq.${result.edital.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body,
    });
  }
}

async function main() {
  const candidatos = await fetchCandidatos();
  console.log(`editais_corretos a processar: ${candidatos.length}`);
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
      const p = r.perfil || {};
      const resumo = r.perfil
        ? `meses=${p.prazo_execucao_meses ?? "-"} valor=${p.valor_global_projeto ?? "-"} parcelas=${p.num_parcelas ?? "-"} tgov=${p.transferegov ?? "-"} obra=${p.exige_obra ?? "-"} clt=${p.clt ?? "-"} 14133=${p.lei_14133_integral ?? "-"} pd=${p.pd_inovacao ?? "-"}`
        : r.erro || "";
      console.log(`[${results.length}/${candidatos.length}] ${r.status.padEnd(12)} ${(r.edital.fonte || "").padEnd(12)} ${resumo}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const custo = results.reduce((s, r) => s + (r.costUsd || 0), 0);
  const porStatus = results.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
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
          perfil: r.perfil || null,
          rejeitados_sem_evidencia: r.rejeitados || [],
          erro: r.erro || null,
        })),
        null,
        2,
      ),
    );
    console.log(`resultados salvos em ${OUT}`);
  }

  if (WRITE) {
    const ok = results.filter((r) => r.perfil);
    for (const r of ok) await persist(r);
    console.log(`gravados: ${ok.length}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
