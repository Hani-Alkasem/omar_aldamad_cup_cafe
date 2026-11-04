/**
 * Failed token requests per key (client id, and caller IP) in a sliding window.
 * In-memory per API replica: with N replicas an attacker gets N× the budget, which against
 * 256-bit secrets is irrelevant; the point is to stop log flooding and runaway retry loops.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly max = 10,
    private readonly windowMs = 5 * 60_000,
  ) {}

  private recent(key: string, now: number) {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** Seconds until the key may try again, or 0. */
  blockedFor(key: string, now = Date.now()): number {
    const list = this.recent(key, now);
    return list.length >= this.max ? Math.ceil((list[0] + this.windowMs - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()) {
    this.hits.set(key, [...this.recent(key, now), now]);
    // Bound memory under a spray of random ids.
    if (this.hits.size > 10_000) this.hits.delete(this.hits.keys().next().value as string);
  }

  clear(key: string) {
    this.hits.delete(key);
  }
}
