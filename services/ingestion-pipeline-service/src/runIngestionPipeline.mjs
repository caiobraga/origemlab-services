/**
 * Pipeline único: scraper-runner → document-processor.
 * Substitui scraper agendado + document-processor contínuo por uma task ECS agendada.
 */
import "./loadEnv.mjs";

import { runScraperBatch } from "../../scraper-runner/src/main.mjs";
import { runDocumentProcessor } from "../../document-processor/src/main.mjs";

function ecsWorkerLoopEnabled() {
  const v = String(process.env.ECS_WORKER_LOOP || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function workerIdleMsAfterWork() {
  const n = parseInt(process.env.WORKER_IDLE_MS_AFTER_WORK || "8000", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 8000;
}

function workerIdleMsNoWork() {
  const n = parseInt(process.env.WORKER_IDLE_MS_NO_WORK || "120000", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 120000;
}

function skipScraperPhase() {
  return String(process.env.PIPELINE_SKIP_SCRAPER || "").trim() === "1";
}

function skipDocumentPhase() {
  return String(process.env.PIPELINE_SKIP_DOCUMENT_PROCESSOR || "").trim() === "1";
}

function scraperArgv() {
  const source = String(process.env.SCRAPER_SOURCE || "all").trim() || "all";
  return ["--source", source];
}

function documentArgv() {
  const extra = String(process.env.DOCUMENT_PROCESSOR_ARGS || "").trim();
  if (!extra) return [];
  return extra.split(/\s+/).filter(Boolean);
}

export async function runIngestionPipelineOnce() {
  let scraperFailed = false;
  let documentFailed = false;
  let queueLength = 0;

  if (!skipScraperPhase()) {
    console.log("\n════════════════════════════════════════");
    console.log("  Fase 1/2 — scraper-runner");
    console.log("════════════════════════════════════════\n");
    const prevCode = process.exitCode;
    try {
      await runScraperBatch(scraperArgv());
    } catch (e) {
      scraperFailed = true;
      console.error("❌ Fase scraper falhou:", e);
    }
    if (process.exitCode && process.exitCode !== 0) {
      scraperFailed = true;
      process.exitCode = prevCode ?? 0;
    }
  } else {
    console.log("⏭️ PIPELINE_SKIP_SCRAPER=1 — fase scraper ignorada.");
  }

  if (!skipDocumentPhase()) {
    console.log("\n════════════════════════════════════════");
    console.log("  Fase 2/2 — document-processor");
    console.log("════════════════════════════════════════\n");
    const prevCode = process.exitCode;
    try {
      const r = await runDocumentProcessor(documentArgv());
      queueLength = r?.queueLength ?? 0;
    } catch (e) {
      documentFailed = true;
      console.error("❌ Fase document-processor falhou:", e);
    }
    if (process.exitCode && process.exitCode !== 0) {
      documentFailed = true;
      process.exitCode = prevCode ?? 0;
    }
  } else {
    console.log("⏭️ PIPELINE_SKIP_DOCUMENT_PROCESSOR=1 — fase document-processor ignorada.");
  }

  console.log(
    `\n✅ Ingestion pipeline concluído. scraper_failed=${scraperFailed} document_failed=${documentFailed} pdf_queue=${queueLength}`,
  );

  if (scraperFailed || documentFailed) {
    process.exitCode = 1;
  }

  return { scraperFailed, documentFailed, queueLength };
}

async function main() {
  console.log("🔗 ingestion-pipeline-service (scraper → document-processor)");
  console.log(
    `   skip_scraper=${skipScraperPhase()} skip_document=${skipDocumentPhase()} worker_loop=${ecsWorkerLoopEnabled()} scraper_source=${process.env.SCRAPER_SOURCE || "all"}`,
  );

  if (ecsWorkerLoopEnabled()) {
    let iter = 0;
    console.log(
      `🔄 ECS_WORKER_LOOP=1 — pipeline em ciclo. Idle após trabalho=${workerIdleMsAfterWork()}ms; fila vazia=${workerIdleMsNoWork()}ms`,
    );
    while (true) {
      iter += 1;
      console.log(`\n🔄 pipeline iter=${iter} @ ${new Date().toISOString()}`);
      try {
        const { queueLength } = await runIngestionPipelineOnce();
        const idle = queueLength === 0 ? workerIdleMsNoWork() : workerIdleMsAfterWork();
        if (idle > 0) await new Promise((r) => setTimeout(r, idle));
      } catch (e) {
        console.error("❌ pipeline iter:", e);
        await new Promise((r) => setTimeout(r, workerIdleMsNoWork()));
      }
    }
  }

  await runIngestionPipelineOnce();
}

main().catch((e) => {
  console.error("❌ fatal:", e);
  process.exitCode = 1;
});
