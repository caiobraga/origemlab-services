/**
 * Lista editais com títulos que não parecem edital (adendo, badge, orgão, etc.).
 */
import { loadEnv } from "../src/loadEnv.mjs";
import { createClient } from "@supabase/supabase-js";
import { isSupplementTitle, normalizeSpaces } from "../src/scraperTitleUtils.mjs";

loadEnv();

const BAD_TITLE_RE =
  /^(ADENDO|RETIFICA|ERRATA|ANEXO|RESULTADO|HOMOLOGA|AVISO|ESCLARECIMENTO|EXTRATO|NOTA\s+EXPLICATIVA|ATA\s+DE|Pesquisadores|Empresas|Novo|FUNCAP|FACEPE|FAPERN|FINEP|SECTI|Aberto|Encerrado|•)$/i;

const SHORT_OR_BAD =
  /^(pesquisadores|empresas|novo|aberto|encerrado|funcap|facepe|fapern|finep|secti|•|—|-)$/i;

function looksSuspicious(titulo, fonte) {
  const t = normalizeSpaces(titulo);
  if (!t || t.length < 4) return { yes: true, reason: "vazio/curto" };
  if (t.length <= 12 && SHORT_OR_BAD.test(t)) return { yes: true, reason: "badge/rótulo" };
  if (BAD_TITLE_RE.test(t)) return { yes: true, reason: "padrão inválido" };
  if (isSupplementTitle(t)) return { yes: true, reason: "adendo/suplemento" };
  if (/^ADENDO\s+N[º°]/i.test(t)) return { yes: true, reason: "adendo" };
  if (t === fonte || t.toUpperCase() === String(fonte || "").toUpperCase()) return { yes: true, reason: "igual à fonte" };
  if (!/\d/.test(t) && t.length < 25 && !/edital|chamada|programa|bolsa|seleção|selecao/i.test(t)) {
    return { yes: true, reason: "sem número nem palavra-chave" };
  }
  return { yes: false, reason: "" };
}

async function main() {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: editais, error } = await sb
    .from("editais")
    .select("id,fonte,titulo,numero,valor_projeto,prazo_inscricao,descricao,sobre_programa,informacoes_processadas_em,link")
    .order("criado_em", { ascending: false });
  if (error) throw new Error(error.message);

  const suspicious = [];
  for (const e of editais || []) {
    const check = looksSuspicious(e.titulo, e.fonte);
    if (check.yes) suspicious.push({ ...e, reason: check.reason });
  }

  console.log(`\n📋 Total editais: ${editais?.length ?? 0}`);
  console.log(`⚠️ Títulos suspeitos: ${suspicious.length}\n`);

  const byFonte = new Map();
  for (const s of suspicious) {
    byFonte.set(s.fonte, (byFonte.get(s.fonte) || 0) + 1);
  }
  console.log("Por fonte:");
  [...byFonte.entries()].sort((a, b) => b[1] - a[1]).forEach(([f, n]) => console.log(`  ${f}: ${n}`));

  console.log("\nAmostra (até 40):");
  for (const s of suspicious.slice(0, 40)) {
    const proc = s.informacoes_processadas_em ? "proc✓" : "proc—";
    const campos = [
      s.valor_projeto ? "valor" : "",
      s.prazo_inscricao ? "prazo" : "",
      s.sobre_programa ? "sobre" : "",
    ]
      .filter(Boolean)
      .join(",");
    console.log(
      `  [${s.fonte}] ${s.reason} | ${proc} | num=${s.numero || "—"} | "${String(s.titulo).slice(0, 70)}" | campos:${campos || "—"}`,
    );
  }

  const funcap = suspicious.filter((s) => s.fonte === "funcap");
  if (funcap.length) {
    console.log(`\n🔍 FUNCAP suspeitos (${funcap.length}):`);
    for (const s of funcap.slice(0, 15)) {
      console.log(`   "${s.titulo}" | ${s.link?.slice(0, 60) || ""}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
