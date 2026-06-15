/**
 * Pipeline único: validate-editais-corretos → process-edital-info (opcional).
 * Default: valida o backlog primeiro; process-edital fica em 0 editais por iteração.
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

function skipValidatePhase(): boolean {
  return String(process.env.PIPELINE_SKIP_VALIDATE || "").trim() === "1";
}

/** Máx. editais na fase process após validate. Default 0 = não processar nesta iteração. */
function pipelineProcessLimit(): number {
  if (String(process.env.PIPELINE_SKIP_PROCESS || "").trim() === "1") return 0;
  const raw = String(process.env.PIPELINE_PROCESS_LIMIT ?? "0").trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function withProcessEditalLimit<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PROCESS_EDITAL_LIMIT;
  process.env.PROCESS_EDITAL_LIMIT = String(limit);
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PROCESS_EDITAL_LIMIT;
    else process.env.PROCESS_EDITAL_LIMIT = prev;
  }
}

async function runValidatePhase(): Promise<{ hadWork: boolean; failed: boolean }> {
  if (skipValidatePhase()) {
    console.log("⏭️ PIPELINE_SKIP_VALIDATE=1 — fase validate-edital ignorada.");
    return { hadWork: false, failed: false };
  }

  console.log("\n════════════════════════════════════════");
  console.log("  Fase 1/2 — validate-editais-corretos");
  console.log("════════════════════════════════════════\n");

  const prevCode = process.exitCode;
  let hadWork = false;
  let failed = false;
  try {
    const r = await runValidateBatch();
    hadWork = r.hadWork;
  } catch (e) {
    failed = true;
    console.error("❌ Fase validate-edital falhou:", e);
  }
  if (process.exitCode && process.exitCode !== 0) {
    failed = true;
    process.exitCode = prevCode ?? 0;
  }
  return { hadWork, failed };
}

async function runProcessPhase(limit: number): Promise<{ hadWork: boolean; failed: boolean }> {
  if (limit <= 0) {
    console.log(
      "\n⏭️ PIPELINE_PROCESS_LIMIT=0 — fase process-edital ignorada (0 editais nesta iteração).",
    );
    console.log("   Para reativar: PIPELINE_PROCESS_LIMIT=N ou PIPELINE_SKIP_PROCESS=0 + limite > 0.");
    return { hadWork: false, failed: false };
  }

  console.log("\n════════════════════════════════════════");
  console.log(`  Fase 2/2 — process-edital-info (limite=${limit})`);
  console.log("════════════════════════════════════════\n");

  const prevCode = process.exitCode;
  let hadWork = false;
  let failed = false;
  try {
    const r = await withProcessEditalLimit(limit, () => runProcessBatch());
    hadWork = r.hadWork;
  } catch (e) {
    failed = true;
    console.error("❌ Fase process-edital falhou:", e);
  }
  if (process.exitCode && process.exitCode !== 0) {
    failed = true;
    process.exitCode = prevCode ?? 0;
  }
  return { hadWork, failed };
}

export async function runEditalPipelineOnce(): Promise<{
  processHadWork: boolean;
  validateHadWork: boolean;
  processFailed: boolean;
  validateFailed: boolean;
}> {
  const processLimit = pipelineProcessLimit();

  const validate = await runValidatePhase();
  const process = await runProcessPhase(processLimit);

  console.log(
    `\n✅ Pipeline concluído. validate_hadWork=${validate.hadWork} process_hadWork=${process.hadWork} validate_failed=${validate.failed} process_failed=${process.failed} process_limit=${processLimit}`,
  );

  if (validate.failed || process.failed) {
    process.exitCode = 1;
  }

  return {
    processHadWork: process.hadWork,
    validateHadWork: validate.hadWork,
    processFailed: process.failed,
    validateFailed: validate.failed,
  };
}

async function main() {
  const processLimit = pipelineProcessLimit();
  console.log("🔗 edital-pipeline-service (validate → process)");
  console.log(
    `   skip_validate=${skipValidatePhase()} process_limit=${processLimit} worker_loop=${ecsWorkerLoopEnabled()}`,
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
