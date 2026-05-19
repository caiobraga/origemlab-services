/**
 * Pipeline único: process-edital-info → validate-editais-corretos.
 * Substitui dois ECS Services contínuos por uma task agendada (ou loop opcional).
 */
import "./load-env.js";

import { runProcessBatch } from "../../process-edital-service/src/api/processEditalInfo.js";
import { runValidateBatch } from "../../validate-edital-service/src/api/validateEditaisCorretos.js";

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

function skipProcessPhase(): boolean {
  return String(process.env.PIPELINE_SKIP_PROCESS || "").trim() === "1";
}

function skipValidatePhase(): boolean {
  return String(process.env.PIPELINE_SKIP_VALIDATE || "").trim() === "1";
}

export async function runEditalPipelineOnce(): Promise<{
  processHadWork: boolean;
  validateHadWork: boolean;
  processFailed: boolean;
  validateFailed: boolean;
}> {
  let processHadWork = false;
  let validateHadWork = false;
  let processFailed = false;
  let validateFailed = false;

  if (!skipProcessPhase()) {
    console.log("\n════════════════════════════════════════");
    console.log("  Fase 1/2 — process-edital-info");
    console.log("════════════════════════════════════════\n");
    const prevCode = process.exitCode;
    try {
      const r = await runProcessBatch();
      processHadWork = r.hadWork;
    } catch (e) {
      processFailed = true;
      console.error("❌ Fase process-edital falhou:", e);
    }
    if (process.exitCode && process.exitCode !== 0) {
      processFailed = true;
      process.exitCode = prevCode ?? 0;
    }
  } else {
    console.log("⏭️ PIPELINE_SKIP_PROCESS=1 — fase process-edital ignorada.");
  }

  if (!skipValidatePhase()) {
    console.log("\n════════════════════════════════════════");
    console.log("  Fase 2/2 — validate-editais-corretos");
    console.log("════════════════════════════════════════\n");
    const prevCode = process.exitCode;
    try {
      const r = await runValidateBatch();
      validateHadWork = r.hadWork;
    } catch (e) {
      validateFailed = true;
      console.error("❌ Fase validate-edital falhou:", e);
    }
    if (process.exitCode && process.exitCode !== 0) {
      validateFailed = true;
      process.exitCode = prevCode ?? 0;
    }
  } else {
    console.log("⏭️ PIPELINE_SKIP_VALIDATE=1 — fase validate-edital ignorada.");
  }

  console.log(
    `\n✅ Pipeline concluído. process_hadWork=${processHadWork} validate_hadWork=${validateHadWork} process_failed=${processFailed} validate_failed=${validateFailed}`,
  );

  if (processFailed || validateFailed) {
    process.exitCode = 1;
  }

  return { processHadWork, validateHadWork, processFailed, validateFailed };
}

async function main() {
  console.log("🔗 edital-pipeline-service (process → validate)");
  console.log(
    `   skip_process=${skipProcessPhase()} skip_validate=${skipValidatePhase()} worker_loop=${ecsWorkerLoopEnabled()}`,
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
        const { processHadWork, validateHadWork } = await runEditalPipelineOnce();
        const hadWork = processHadWork || validateHadWork;
        const idle = hadWork ? workerIdleMsAfterWork() : workerIdleMsNoWork();
        if (idle > 0) await new Promise((r) => setTimeout(r, idle));
      } catch (e) {
        console.error("❌ pipeline iter:", e);
        await new Promise((r) => setTimeout(r, workerIdleMsNoWork()));
      }
    }
  }

  await runEditalPipelineOnce();
}

main().catch((e) => {
  console.error("❌ fatal:", e);
  process.exitCode = 1;
});
