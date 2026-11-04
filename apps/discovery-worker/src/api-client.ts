import type { TokenSource } from './auth';
import type { FinishRunInput, RunSpec, SubmitHostsInput } from '@itam/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** The subset of the internal API a run needs; a fake implements it in tests. */
export interface DiscoveryApi {
  openScheduledRun(jobId: string): Promise<{ id: string }>;
  claim(runId: string): Promise<RunSpec>;
  submit(runId: string, body: SubmitHostsInput): Promise<unknown>;
  finish(runId: string, body: FinishRunInput): Promise<unknown>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpDiscoveryApi implements DiscoveryApi {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: TokenSource,
    private readonly retries = 4,
  ) {}

  /** Retries network errors and 5xx with backoff; 4xx are answers, not failures. Every route is idempotent. */
  private async call<T>(path: string, body?: unknown): Promise<T> {
    let last: unknown;
    let reauthed = false;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt) await sleep(Math.min(500 * 2 ** attempt, 8000) + Math.random() * 250);
      try {
        const res = await fetch(`${this.baseUrl}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.auth.get()}` },
          body: JSON.stringify(body ?? {}),
          signal: AbortSignal.timeout(60_000),
        });
        const json = (await res.json().catch(() => ({}))) as { code?: string; message?: string; details?: Record<string, unknown> };
        if (res.ok) return json as T;
        // An expired or rotated token: fetch a new one and try once more.
        if (res.status === 401 && !reauthed) {
          reauthed = true;
          this.auth.invalidate();
          attempt--;
          continue;
        }
        const err = new ApiError(res.status, json.code ?? 'ERROR', json.message ?? res.statusText, json.details);
        if (res.status < 500) throw err;
        last = err;
      } catch (e) {
        if (e instanceof ApiError && e.status < 500) throw e;
        last = e;
      }
    }
    throw last;
  }

  openScheduledRun(jobId: string) {
    return this.call<{ id: string }>(`/internal/discovery/jobs/${jobId}/runs`);
  }
  claim(runId: string) {
    return this.call<RunSpec>(`/internal/discovery/runs/${runId}/claim`);
  }
  submit(runId: string, body: SubmitHostsInput) {
    return this.call(`/internal/discovery/runs/${runId}/hosts`, body);
  }
  finish(runId: string, body: FinishRunInput) {
    return this.call(`/internal/discovery/runs/${runId}/finish`, body);
  }
}
