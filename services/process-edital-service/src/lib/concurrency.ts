/** Lê env de concorrência (mín. 1, máx. `maxCap`). */
export function readConcurrencyEnv(name: string, fallback: number, maxCap = 8): number {
  const raw = parseInt(process.env[name] || String(fallback), 10);
  if (!Number.isFinite(raw) || raw < 1) return Math.max(1, fallback);
  return Math.min(maxCap, Math.max(1, raw));
}

/** Executa `fn` em paralelo com no máximo `concurrency` tarefas ativas. Preserva ordem dos resultados. */
export async function mapPool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.min(Math.max(1, concurrency), items.length);
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = nextIndex;
      nextIndex += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => worker()));
  return results;
}
