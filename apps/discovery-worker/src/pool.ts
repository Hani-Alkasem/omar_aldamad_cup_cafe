/** Run `task` over `items` with at most `limit` in flight; stops pulling new items once `signal` aborts. */
export async function forEachLimit<T>(items: Iterable<T>, limit: number, task: (item: T) => Promise<void>, signal?: AbortSignal) {
  const it = items[Symbol.iterator]();
  const lane = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const next = it.next();
      if (next.done) return;
      await task(next.value);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, limit) }, lane));
}
