import { isInventoryProtocol, type DiscoveryProtocol, type HostFacts, type HostFailure, type RunSpec } from '@itam/shared';
import type { InventoryCollector } from './collectors/inventory';
import { ApiError, type DiscoveryApi } from './api-client';
import type { Collector } from './collectors/types';
import { forEachLimit } from './pool';
import { expandTargets } from './targets';

export interface RunDeps {
  api: DiscoveryApi;
  collectors: Partial<Record<DiscoveryProtocol, Collector>>;
  inventory?: Partial<Record<'vsphere' | 'aws' | 'azure', InventoryCollector>>;
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
  if (isInventoryProtocol(spec.protocol)) return executeInventoryRun(spec, deps);
  const collector = deps.collectors[spec.protocol];
  if (!collector) throw new Error(`no collector for ${spec.protocol}`);
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

/**
 * Inventory jobs: per endpoint, the first credential that works returns every host and VM; results
 * go to the API in batches. An endpoint where every credential fails is reported as one failure.
 */
async function executeInventoryRun(spec: RunSpec, deps: RunDeps): Promise<RunReport> {
  const collector = deps.inventory?.[spec.protocol as 'vsphere' | 'aws' | 'azure'];
  if (!collector) throw new Error(`no inventory collector for ${spec.protocol}`);
  const batchSize = deps.batchSize ?? 50;
  let scanned = 0;
  let failed = 0;
  let stopped: string | undefined;
  let deliveryError: string | undefined;
  const send = async (hosts: HostFacts[], failures: HostFailure[]) => {
    try {
      await deps.api.submit(spec.runId, { scannedDelta: hosts.length, hosts, failures });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'RUN_NOT_RUNNING') stopped = e.message;
      else deliveryError ??= (e as Error).message;
      throw e;
    }
  };
  const heartbeat = setInterval(() => void deps.api.submit(spec.runId, { scannedDelta: 0 }).catch(() => undefined), deps.flushIntervalMs ?? Math.min(5000, (spec.leaseSeconds * 1000) / 4));
  try {
    for (const endpoint of spec.endpoints) {
      if (deps.signal?.aborted) break;
      let last: { kind: string; message: string } | undefined;
      let hosts: HostFacts[] | undefined;
      for (const cred of spec.credentials) {
        const r = await collector.inventory(endpoint, cred, spec.options);
        if (r.kind === 'facts') {
          hosts = r.hosts;
          for (const w of r.warnings) deps.log('inventory warning', { runId: spec.runId, endpoint, warning: w });
          break;
        }
        last = r;
      }
      if (!hosts) {
        failed++;
        await send([], [{ ip: endpoint, outcome: last?.kind === 'auth_failed' ? 'auth_failed' : 'error', message: last?.kind === 'auth_failed' ? `all ${spec.credentials.length} credential(s) rejected` : (last?.message ?? 'no result') }]).catch(() => undefined);
        if (stopped) break;
        continue;
      }
      // Hosts before VMs within a batch is not required: runs_on edges are built at finish.
      const capped = hosts.slice(0, spec.maxHosts - scanned);
      for (let i = 0; i < capped.length; i += batchSize) {
        await send(capped.slice(i, i + batchSize), []).catch(() => undefined);
        if (stopped || deliveryError) break;
      }
      scanned += capped.length;
      deps.log('endpoint inventoried', { runId: spec.runId, endpoint, hosts: capped.length, truncated: hosts.length > capped.length });
      if (stopped || deliveryError || scanned >= spec.maxHosts) break;
    }
  } finally {
    clearInterval(heartbeat);
  }
  if (stopped) return { status: 'failed', scanned, responded: scanned, failed, error: stopped };
  const status: RunReport['status'] = deliveryError || deps.signal?.aborted ? 'partial' : failed && failed === spec.endpoints.length ? 'failed' : failed ? 'partial' : 'succeeded';
  const error = deliveryError ? `results could not be delivered: ${deliveryError}` : deps.signal?.aborted ? 'worker shut down before the inventory completed' : failed ? `${failed} of ${spec.endpoints.length} endpoint(s) failed` : undefined;
  await deps.api.finish(spec.runId, { status, ...(error ? { error } : {}) });
  return { status, scanned, responded: scanned, failed, ...(error ? { error } : {}) };
}
