import { DISCOVERY_QUEUE, type DiscoveryQueueJob } from '@itam/shared';
import { DelayedError, Worker, type Job } from 'bullmq';
import { ApiError, HttpDiscoveryApi } from './api-client';
import { ClientCredentials, StaticToken } from './auth';
import { SnmpCollector } from './collectors/snmp';
import { SshCollector } from './collectors/ssh';
import { loadConfig } from './config';
import { executeRun } from './run';

const log = (msg: string, extra: Record<string, unknown> = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), msg, ...extra }));

const config = loadConfig();
const auth = config.client ? new ClientCredentials(config.apiUrl, config.client.id, config.client.secret) : new StaticToken(config.token!);
const api = new HttpDiscoveryApi(config.apiUrl, auth);
const collectors = { snmp: new SnmpCollector(), ssh: new SshCollector() };
const shutdown = new AbortController();

/** Answers that mean "nothing to do", not "retry". */
const SKIP = new Set(['RUN_IN_PROGRESS', 'JOB_DISABLED', 'NOT_FOUND', 'NO_USABLE_CREDENTIALS']);
const MAX_RECLAIM_WAITS = 3;

async function handle(job: Job<DiscoveryQueueJob & { reclaimWaits?: number }>, token?: string) {
  let runId = job.data.runId;
  try {
    if (!runId) runId = (await api.openScheduledRun(job.data.jobId)).id;
    const spec = await api.claim(runId);
    log('run claimed', { runId, jobId: spec.jobId, protocol: spec.protocol, targets: spec.targets });
    const report = await executeRun(spec, { api, collectors, log, signal: shutdown.signal });
    log('run finished', { runId, ...report });
    return report;
  } catch (e) {
    if (!(e instanceof ApiError)) throw e; // network trouble: let BullMQ retry with backoff
    if (SKIP.has(e.code)) {
      log('nothing to run', { jobId: job.data.jobId, runId, code: e.code });
      return { skipped: e.code };
    }
    // Another worker held the run and stopped reporting: wait for its lease to lapse, then reclaim.
    if (e.code === 'RUN_NOT_CLAIMABLE' && e.details?.status === 'running' && (job.data.reclaimWaits ?? 0) < MAX_RECLAIM_WAITS && token) {
      await job.updateData({ ...job.data, reclaimWaits: (job.data.reclaimWaits ?? 0) + 1 });
      await job.moveToDelayed(Date.now() + 60_000, token);
      throw new DelayedError();
    }
    if (e.code === 'RUN_NOT_CLAIMABLE') return { skipped: e.code };
    throw e;
  }
}

const url = new URL(config.redisUrl);
const worker = new Worker<DiscoveryQueueJob>(DISCOVERY_QUEUE, handle, {
  connection: {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: url.username || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  },
  concurrency: config.concurrency,
  // Sweeps run for minutes; BullMQ renews this lock while the process is alive.
  lockDuration: 60_000,
});

worker.on('ready', () => log('worker ready', { queue: DISCOVERY_QUEUE, concurrency: config.concurrency, api: config.apiUrl, auth: config.client ? `client ${config.client.id}` : 'static token' }));
worker.on('failed', (job, err) => log('job failed', { jobId: job?.data.jobId, runId: job?.data.runId, error: err.message }));
worker.on('error', (err) => log('worker error', { error: err.message }));

let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    log('shutting down', { signal: sig });
    shutdown.abort(); // in-flight runs finish as "partial" with what they have
    await worker.close();
    process.exit(0);
  });
}
