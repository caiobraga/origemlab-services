/**
 * Executa fn(item, index) com limite de concorrência (ordem dos resultados preservada).
 */
export async function mapWithConcurrency(items, concurrency, fn) {
  if (!items.length) return [];
  const n = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array(items.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}
