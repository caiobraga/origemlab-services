/**
 * Roda cada fonte do scraper isoladamente e resume ok/falha.
 */
import { loadEnv } from "../../scraper-runner/src/loadEnv.mjs";
import { runScraperBatch } from "../../scraper-runner/src/main.mjs";

loadEnv();

const SOURCES = [
  "finep",
  "rotadofomento",
  "plataforma-inovacao-industria",
  "fapern",
  "capta",
  "fapac",
  "secti",
  "funcap",
  "facepe",
  "fapdf",
  "fapeal",
  "fapema",
  "fapepi",
  "fapergs",
  "faperj",
  "fapesc",
  "fapespa",
  "fapesq",
  "fapitec",
  "fapt",
  "cnpq",
  "fapemig",
  "fapemat",
  "fapes",
  "prosas",
  "sigfapes",
];

async function main() {
  process.env.DISABLE_EVENTBRIDGE = process.env.DISABLE_EVENTBRIDGE || "1";
  const results = [];
  for (let i = 0; i < SOURCES.length; i++) {
    const s = SOURCES[i];
    const t0 = Date.now();
    console.log(`\n━━━ (${i + 1}/${SOURCES.length}) ${s} ━━━`);
    try {
      const r = await runScraperBatch(["--source", s]);
      const one = r?.sources?.[s] ?? r;
      const ok = one?.ok !== false;
      results.push({
        source: s,
        ok,
        ms: Date.now() - t0,
        total: one?.total,
        new_editais: one?.new_editais,
        new_pdfs: one?.new_pdfs,
        error: one?.error,
      });
      console.log(
        ok
          ? `✅ ${s}: total=${one?.total ?? "?"} novos=${one?.new_editais ?? 0} pdfs=${one?.new_pdfs ?? 0} (${Math.round((Date.now() - t0) / 1000)}s)`
          : `❌ ${s}: ${one?.error || "falhou"}`,
      );
    } catch (e) {
      const errMsg =
        e instanceof Error
          ? e.message
          : e && typeof e === "object" && "message" in e
            ? String(e.message)
            : JSON.stringify(e);
      results.push({
        source: s,
        ok: false,
        ms: Date.now() - t0,
        error: errMsg,
      });
      console.log(`❌ ${s}: ${errMsg}`);
    }
  }

  console.log("\n════════ RESUMO SCRAPER ════════");
  for (const r of results) {
    console.log(
      `${r.ok ? "✅" : "❌"} ${r.source.padEnd(32)} ${String(Math.round(r.ms / 1000)).padStart(4)}s  total=${r.total ?? "-"} novos=${r.new_editais ?? "-"} err=${r.error || ""}`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
