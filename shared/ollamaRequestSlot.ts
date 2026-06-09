/**
 * Serializa pedidos ao Ollama (generate + embed) no mesmo processo.
 * Evita segfault/OOM quando o servidor tem OLLAMA_NUM_PARALLEL=1 mas o cliente dispara em paralelo.
 */
let chain: Promise<void> = Promise.resolve();

export function ollamaSerializeEnabled(): boolean {
  return String(process.env.OLLAMA_SERIALIZE_REQUESTS ?? "1").trim() !== "0";
}

function slotGapMs(): number {
  const raw = parseInt(process.env.OLLAMA_SLOT_GAP_MS || "600", 10);
  return Number.isFinite(raw) ? Math.max(0, raw) : 600;
}

export async function withOllamaSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (!ollamaSerializeEnabled()) return fn();

  let release!: () => void;
  const prev = chain;
  chain = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prev;
  try {
    return await fn();
  } finally {
    const gap = slotGapMs();
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    release();
  }
}
