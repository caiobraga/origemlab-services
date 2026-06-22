/**
 * Pipeline único: process-edital-info (até N editais) → validate-editais-corretos (só os recém-processados).
 * Cada iteração: extrai campos de até PIPELINE_PROCESS_LIMIT editais, depois valida apenas esses IDs.
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

/** Modo legado: validate do backlog antes do process (desligado por padrão). */
function validateBacklogFirst(): boolean {
  return String(process.env.PIPELINE_VALIDATE_BACKLOG || "").trim() === "1";
}

const DEFAULT_PIPELINE_BATCH_LIMIT = 50;

/** Máx. editais na fase process. Default 50; 0 = não processar nesta iteração. */
function pipelineProcessLimit(): number {
  if (String(process.env.PIPELINE_SKIP_PROCESS || "").trim() === "1") return 0;
  const raw = String(process.env.PIPELINE_PROCESS_LIMIT ?? String(DEFAULT_PIPELINE_BATCH_LIMIT)).trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Limite do validate em modo backlog (só com PIPELINE_VALIDATE_BACKLOG=1). */
function pipelineValidateBacklogLimit(): number {
  const raw = String(process.env.PIPELINE_VALIDATE_LIMIT ?? String(DEFAULT_PIPELINE_BATCH_LIMIT)).trim();
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PIPELINE_BATCH_LIMIT;
}

async function withEnvOverrides<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(overrides)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withValidateEditalIds<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
  return withEnvOverrides(
    {
      VALIDATE_EDITAL_IDS: ids.length > 0 ? ids.join(",") : undefined,
      VALIDATE_EDITAIS_LIMIT: ids.length > 0 ? String(ids.length) : undefined,
    },
    fn,
  );
}

async function withValidateBacklogEnv<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  const overrides: Record<string, string | undefined> = {
    VALIDATE_EDITAL_IDS: undefined,
  };
  if (limit > 0) overrides.VALIDATE_EDITAIS_LIMIT = String(limit);
  return withEnvOverrides(overrides, fn);
}

async function withProcessPipelineEnv<T>(limit: number, fn: () => Promise<T>): Promise<T> {
  const overrides: Record<string, string | undefined> = {
    PROCESS_EDITAL_LIMIT: String(limit),
  };
  if (String(process.env.PIPELINE_PROCESS_FILTERS || "").trim() !== "0") {
    overrides.PROCESS_EDITAL_BACKLOG_ONLY =
      process.env.PROCESS_EDITAL_BACKLOG_ONLY ?? "1";
    overrides.PROCESS_EDITAL_CHUNKS_ONLY =
      process.env.PROCESS_EDITAL_CHUNKS_ONLY ?? "1";
    overrides.PROCESS_EDITAL_WEAK_ONLY = process.env.PROCESS_EDITAL_WEAK_ONLY ?? "1";
  }
  return withEnvOverrides(overrides, fn);
}

async function runValidatePhase(
  processedIds: string[],
): Promise<{ hadWork: boolean; failed: boolean }> {
  if (skipValidatePhase()) {
    console.log("⏭️ PIPELINE_SKIP_VALIDATE=1 — fase validate-edital ignorada.");
    return { hadWork: false, failed: false };
  }

  if (processedIds.length === 0) {
    console.log("\n⏭️ Nenhum edital processado com sucesso neste lote — validate ignorado.");
    return { hadWork: false, failed: false };
  }

  console.log("\n════════════════════════════════════════");
  console.log(`  Fase 2/2 — validate-editais-corretos (${processedIds.length} recém-processado(s))`);
  console.log("════════════════════════════════════════\n");

  const prevCode = process.exitCode;
  let hadWork = false;
  let failed = false;
  try {
    const r = await withValidateEditalIds(processedIds, () => runValidateBatch());
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

async function runValidateBacklogPhase(
  limit: number,
): Promise<{ hadWork: boolean; failed: boolean }> {
  console.log("\n════════════════════════════════════════");
  console.log(
    `  Fase 0 — validate backlog (legado, limite=${limit > 0 ? limit : "∞"})`,
  );
  console.log("════════════════════════════════════════\n");

  const prevCode = process.exitCode;
  let hadWork = false;
  let failed = false;
  try {
    const r = await withValidateBacklogEnv(limit, () => runValidateBatch());
    hadWork = r.hadWork;
  } catch (e) {
    failed = true;
    console.error("❌ Fase validate-backlog falhou:", e);
  }
  if (process.exitCode && process.exitCode !== 0) {
    failed = true;
    process.exitCode = prevCode ?? 0;
  }
  return { hadWork, failed };
}

async function runProcessPhase(
  limit: number,
): Promise<{ hadWork: boolean; failed: boolean; processedIds: string[] }> {
  if (limit <= 0) {
    console.log(
      "\n⏭️ PIPELINE_PROCESS_LIMIT=0 — fase process-edital ignorada (0 editais nesta iteração).",
    );
    return { hadWork: false, failed: false, processedIds: [] };
  }

  console.log("\n════════════════════════════════════════");
  console.log(`  Fase 1/2 — process-edital-info (limite=${limit})`);
  console.log("════════════════════════════════════════\n");

  const prevCode = process.exitCode;
  let hadWork = false;
  let failed = false;
  let processedIds: string[] = [];
  try {
    const r = await withProcessPipelineEnv(limit, () => runProcessBatch());
    hadWork = r.hadWork;
    processedIds = r.processedIds;
  } catch (e) {
    failed = true;
    console.error("❌ Fase process-edital falhou:", e);
  }
  if (process.exitCode && process.exitCode !== 0) {
    failed = true;
    process.exitCode = prevCode ?? 0;
  }
  return { hadWork, failed, processedIds };
}

export async function runEditalPipelineOnce(): Promise<{
  processHadWork: boolean;
  validateHadWork: boolean;
  processFailed: boolean;
  validateFailed: boolean;
  processedIds: string[];
}> {
  const processLimit = pipelineProcessLimit();
  let validateHadWork = false;
  let validateFailed = false;

  if (validateBacklogFirst()) {
    const backlog = await runValidateBacklogPhase(pipelineValidateBacklogLimit());
    validateHadWork = validateHadWork || backlog.hadWork;
    validateFailed = validateFailed || backlog.failed;
  }

  const process = await runProcessPhase(processLimit);
  const validate = await runValidatePhase(process.processedIds);
  validateHadWork = validateHadWork || validate.hadWork;
  validateFailed = validateFailed || validate.failed;

  console.log(
    `\n✅ Pipeline concluído. process_hadWork=${process.hadWork} validate_hadWork=${validateHadWork} process_failed=${process.failed} validate_failed=${validateFailed} process_limit=${processLimit} validated_ids=${process.processedIds.length} backlog_first=${validateBacklogFirst()}`,
  );

  if (validateFailed || process.failed) {
    process.exitCode = 1;
  }

  return {
    processHadWork: process.hadWork,
    validateHadWork,
    processFailed: process.failed,
    validateFailed,
    processedIds: process.processedIds,
  };
}

async function main() {
  const processLimit = pipelineProcessLimit();
  console.log("🔗 edital-pipeline-service (process → validate recém-processados)");
  console.log(
    `   skip_validate=${skipValidatePhase()} process_limit=${processLimit} backlog_validate_first=${validateBacklogFirst()} process_filters=${String(process.env.PIPELINE_PROCESS_FILTERS || "").trim() !== "0"} worker_loop=${ecsWorkerLoopEnabled()}`,
  );

  if (ecsWorkerLoopEnabled()) {
    let iter = 0;
    console.log(
      `🔄 ECS_WORKER_LOOP=1 — ciclo: process (até ${processLimit}) → validate (só IDs do lote). Idle após trabalho=${workerIdleMsAfterWork()}ms; fila vazia=${workerIdleMsNoWork()}ms`,
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
