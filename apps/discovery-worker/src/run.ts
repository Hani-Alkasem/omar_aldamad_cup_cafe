import type { DiscoveryProtocol, HostFacts, HostFailure, RunSpec } from '@itam/shared';
import { ApiError, type DiscoveryApi } from './api-client';
import type { Collector } from './collectors/types';
import { forEachLimit } from './pool';
import { expandTargets } from './targets';

export interface RunDeps {
  api: DiscoveryApi;
  collectors: Record<DiscoveryProtocol, Collector>;
  log: (msg: string, extra?: Record<string, unknown>) => void;
  signal?: AbortSignal;
  batchSize?: number;
  flushIntervalMs?: number;
}

export interface RunReport {
  status: 'succeeded' | 'partial' | 'failed';
  scanned: number;
  responded: number;
  failed: number;
  error?: string;
}

/** The API stopped the run (lease swept, or it finished elsewhere): stop work, do not finish it again. */
class RunStopped extends Error {}

/**
 * Probe every target with the job's credentials in order, streaming results to the API in batches.
 * Per host: the first credential that yields facts wins; an auth rejection moves to the next;
 * an unreachable SSH host is abandoned immediately (no point trying more passwords on a closed port).
 */
export async function executeRun(spec: RunSpec, deps: RunDeps): Promise<RunReport> {
  const collector = deps.collectors[spec.protocol];
  const batchSize = deps.batchSize ?? 50;
  let hosts: HostFacts[] = [];
  let failures: HostFailure[] = [];
  let scannedDelta = 0;
  let scanned = 0;
  let responded = 0;
  let failed = 0;
  let flushError: unknown;
  let flushing = Promise.resolve();

  const stop = new AbortController();
  const onAbort = () => stop.abort();
  deps.signal?.addEventListener('abort', onAbort);

  // Serialised flushes keep batches in order and give back-pressure to the probe pool.
  const flush = () => {
    const body = { scannedDelta, hosts, failures };
    hosts = [];
    failures = [];
    scannedDelta = 0;
    flushing = flushing.then(async () => {
      try {
        await deps.api.submit(spec.runId, body);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'RUN_NOT_RUNNING') flushError = new RunStopped(e.message);
        else flushError ??= e;
        stop.abort();
      }
    });
    return flushing;
  };

  // Every few seconds: keeps progress live in the UI and, even when every host is down, extends the lease.
  const heartbeat = setInterval(() => void flush(), deps.flushIntervalMs ?? Math.min(5000, (spec.leaseSeconds * 1000) / 4));

  try {
    await forEachLimit(
      expandTargets(spec.targets, spec.maxHosts),
      spec.options.concurrency,
      async (ip) => {
        let outcome: 'facts' | 'auth' | 'none' | 'error' = 'none';
        let message = '';
        for (const cred of spec.credentials) {
          if (stop.signal.aborted) return;
          const r = await collector.probe(ip, cred, spec.options);
          if (r.kind === 'facts') {
            hosts.push(r.facts);
            outcome = 'facts';
            break;
          }
          if (r.kind === 'auth_failed') {
            outcome = 'auth';
            message = r.message;
            continue;
          }
          if (r.kind === 'error') {
            outcome = 'error';
            message = r.message;
            continue;
          }
          if (spec.protocol === 'ssh') break; // closed or filtered port: same for every credential
        }
        scanned++;
        scannedDelta++;
        if (outcome === 'facts') responded++;
        else if (outcome === 'auth' || outcome === 'error') {
          failed++;
          failures.push({ ip, outcome: outcome === 'auth' ? 'auth_failed' : 'error', message: outcome === 'auth' ? `all ${spec.credentials.length} credential(s) rejected` : message });
        }
        if (hosts.length + failures.length >= batchSize) await flush();
      },
      stop.signal,
    );
    await flush();
  } finally {
    clearInterval(heartbeat);
    deps.signal?.removeEventListener('abort', onAbort);
  }

  if (flushError instanceof RunStopped) {
    deps.log('run stopped by the API', { runId: spec.runId, reason: flushError.message });
    return { status: 'failed', scanned, responded, failed, error: flushError.message };
  }
  const report: RunReport = flushError
    ? { status: 'partial', scanned, responded, failed, error: `results could not be delivered: ${(flushError as Error).message}` }
    : deps.signal?.aborted
      ? { status: 'partial', scanned, responded, failed, error: 'worker shut down before the sweep completed' }
      : { status: 'succeeded', scanned, responded, failed };
  await deps.api.finish(spec.runId, { status: report.status, ...(report.error ? { error: report.error.slice(0, 2000) } : {}) });
  return report;
}
