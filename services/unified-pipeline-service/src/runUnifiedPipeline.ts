/**
 * Pipeline unificado: scraper → document-processor → validate-editais → process-edital.
 * Substitui ingestion-pipeline + edital-pipeline num único container ECS agendado.
 */
import "./load-env.js";

import { runIngestionPipelineOnce } from "../../ingestion-pipeline-service/src/runIngestionPipeline.mjs";
import { runEditalPipelineOnce } from "../../edital-pipeline-service/src/runEditalPipeline.ts";

function ecsWorkerLoopEnabled(): boolean {
  const v = String(process.env.ECS_WORKER_LOOP || "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function workerIdleMsAfterWork(): number {
  const n = parseInt(process.env.WORKER_IDLE_MS_AFTER_WORK || "8000", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 8000;
}

function workerIdleMsNoWork(): number {
  const n = parseInt(process.env.WORKER_IDLE_MS_NO_WORK || "120000", 10);
  return Number.isFinite(n) ? Math.max(0, n) : 120000;
}

export async function runUnifiedPipelineOnce(): Promise<{
  hadWork: boolean;
  failed: boolean;
}> {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║  Fases 1–2 — ingestão (scrape + PDF)   ║");
  console.log("╚════════════════════════════════════════╝\n");

  const ingestion = await runIngestionPipelineOnce();
  const ingestionFailed = ingestion.scraperFailed || ingestion.documentFailed;

  console.log("\n╔════════════════════════════════════════╗");
  console.log("║  Fases 3–4 — edital (validate + process) ║");
  console.log("╚════════════════════════════════════════╝\n");

  const edital = await runEditalPipelineOnce();
  const editalFailed = edital.processFailed || edital.validateFailed;

  const hadWork =
    ingestion.queueLength > 0 || edital.processHadWork || edital.validateHadWork;
  const failed = ingestionFailed || editalFailed;

  console.log(
    `\n✅ Unified pipeline concluído. ingestion_pdf_queue=${ingestion.queueLength} ` +
      `validate_hadWork=${edital.validateHadWork} process_hadWork=${edital.processHadWork} failed=${failed}`,
  );

  if (failed) {
    process.exitCode = 1;
  }

  return { hadWork, failed };
}

async function main() {
  console.log("🔗 unified-pipeline-service");
  console.log(
    "   scraper → document-processor → validate-editais → process-edital-info",
  );
  console.log(`   worker_loop=${ecsWorkerLoopEnabled()}`);

  if (ecsWorkerLoopEnabled()) {
    let iter = 0;
    console.log(
      `🔄 ECS_WORKER_LOOP=1 — ciclo completo. Idle após trabalho=${workerIdleMsAfterWork()}ms; fila vazia=${workerIdleMsNoWork()}ms`,
    );
    while (true) {
      iter += 1;
      console.log(`\n🔄 unified iter=${iter} @ ${new Date().toISOString()}`);
      try {
        const { hadWork } = await runUnifiedPipelineOnce();
        const idle = hadWork ? workerIdleMsAfterWork() : workerIdleMsNoWork();
        if (idle > 0) await new Promise((r) => setTimeout(r, idle));
      } catch (e) {
        console.error("❌ unified iter:", e);
        await new Promise((r) => setTimeout(r, workerIdleMsNoWork()));
      }
    }
  }

  await runUnifiedPipelineOnce();
}

main().catch((e) => {
  console.error("❌ fatal:", e);
  process.exitCode = 1;
});
