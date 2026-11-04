import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { DiscoveryOptions, isInventoryProtocol, type DiscoveryProtocol, type FinishRunInput, type RunSpec, type SubmitHostsInput, SubmitHostsSchema } from '@itam/shared';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { parseIp } from '../ipam/cidr';
import ipaddr from 'ipaddr.js';

const isIp = (s: string) => ipaddr.isValid(s);
import { AuditService } from '../audit/audit.service';
import { CredentialsService } from './credentials.service';
import { runDto } from './jobs.service';
import { ReconcilerService } from './reconciler.service';
import { outboundDependencies, type Outbound } from './reconcile';
import { normaliseTargets } from './targets';

type WorkerCtx = { userId: string; requestId?: string };

/** A worker must check in this often (each batch extends it). */
export const LEASE_SECONDS = 120;
/** After a lease lapses, BullMQ's stalled-job retry gets this long to reclaim before the run is failed. */
const RECLAIM_GRACE_SECONDS = 300;
/** A queued run nobody picked up (Redis lost it, no workers) is failed after this. */
const QUEUED_TIMEOUT_SECONDS = 3600;

@Injectable()
export class RunsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('DiscoveryRuns');
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credentials: CredentialsService,
    private readonly reconciler: ReconcilerService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    if (process.env.DISCOVERY_SWEEPER === 'false') return;
    this.timer = setInterval(() => void this.sweep().catch((e) => this.log.warn(`sweep failed: ${e.message}`)), 60_000);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  /** Fail runs whose worker vanished. Safe to run on every API replica concurrently. */
  async sweep() {
    const failed = await this.prisma.$executeRaw`
      UPDATE discovery_runs SET status = 'failed', finished_at = now(), lease_expires_at = NULL,
             error = CASE WHEN status = 'queued' THEN 'no worker picked the run up' ELSE 'worker stopped reporting (lease expired)' END
      WHERE (status = 'running' AND lease_expires_at < now() - make_interval(secs => ${RECLAIM_GRACE_SECONDS}))
         OR (status = 'queued' AND queued_at < now() - make_interval(secs => ${QUEUED_TIMEOUT_SECONDS}))`;
    if (failed) this.log.warn(`failed ${failed} abandoned discovery run(s)`);
    return failed;
  }

  /**
   * Atomically claim a run and hand over everything needed to execute it.
   * Claimable: queued, or running with a lapsed lease (the previous worker died; BullMQ retried).
   */
  async claim(runId: string, ctx: WorkerCtx): Promise<RunSpec> {
    const result = await this.prisma.$transaction(async (tx): Promise<RunSpec | { unusable: string }> => {
      const [run] = await tx.$queryRaw<Array<{ id: string; job_id: string }>>`
        UPDATE discovery_runs SET status = 'running', started_at = COALESCE(started_at, now()),
               lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
        WHERE id = ${runId}::uuid AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
        RETURNING id, job_id`;
      if (!run) {
        const exists = await tx.discovery_runs.findUnique({ where: { id: runId }, select: { status: true } });
        if (!exists) throw notFound('Discovery run', runId);
        throw conflict('RUN_NOT_CLAIMABLE', `Run is ${exists.status}`, { status: exists.status });
      }
      const [job] = await tx.$queryRaw<Array<{ protocol: DiscoveryProtocol; targets: string[]; endpoints: string[]; max_hosts: number; options: unknown }>>`
        SELECT protocol, targets::text[] AS targets, endpoints, max_hosts, options FROM discovery_jobs WHERE id = ${run.job_id}::uuid`;
      // Inventory jobs do not know their size up front; progress counts what each endpoint returns.
      const hosts = isInventoryProtocol(job.protocol) ? 0 : normaliseTargets(job.targets, job.max_hosts).hosts;
      await tx.discovery_runs.update({ where: { id: runId }, data: { hosts_total: hosts } });

      const { opened, unreadable } = await this.credentials.openForJob(tx, run.job_id, { ...ctx, runId });
      if (!opened.length) {
        // Commit the failure (so the job is free again), then tell the worker.
        const error = `no usable credentials${unreadable.length ? ` (cannot decrypt: ${unreadable.join(', ')})` : ''}`;
        await this.finishTx(tx, runId, { status: 'failed', error });
        return { unusable: error };
      }
      return {
        runId,
        jobId: run.job_id,
        protocol: job.protocol,
        targets: job.targets,
        endpoints: job.endpoints,
        maxHosts: job.max_hosts,
        options: DiscoveryOptions.parse(job.options ?? {}),
        leaseSeconds: LEASE_SECONDS,
        credentials: opened,
      };
    }, TX_OPTIONS);
    if ('unusable' in result) throw unprocessable('NO_USABLE_CREDENTIALS', result.unusable);
    return result;
  }

  private async requireRunning(tx: Tx, runId: string) {
    const [r] = await tx.$queryRaw<Array<{ status: string; vrf_id: string | null }>>`
      SELECT r.status, j.vrf_id FROM discovery_runs r JOIN discovery_jobs j ON j.id = r.job_id WHERE r.id = ${runId}::uuid FOR UPDATE OF r`;
    if (!r) throw notFound('Discovery run', runId);
    if (r.status !== 'running') throw conflict('RUN_NOT_RUNNING', `Run is ${r.status}; stop sending results`, { status: r.status });
    return r;
  }

  /** Counters are recomputed from results, so a retried batch never double-counts. */
  private async recount(tx: Tx, runId: string) {
    await tx.$executeRaw`
      UPDATE discovery_runs r SET
        hosts_responded = c.responded, created_count = c.created, updated_count = c.updated,
        unchanged_count = c.unchanged, conflict_count = c.conflict, failed_count = c.failed
      FROM (
        SELECT count(*) FILTER (WHERE outcome NOT IN ('error')) AS responded,
               count(*) FILTER (WHERE outcome = 'created') AS created,
               count(*) FILTER (WHERE outcome = 'updated') AS updated,
               count(*) FILTER (WHERE outcome = 'unchanged') AS unchanged,
               count(*) FILTER (WHERE outcome = 'conflict') AS conflict,
               count(*) FILTER (WHERE outcome IN ('auth_failed', 'error')) AS failed
        FROM discovery_results WHERE run_id = ${runId}::uuid
      ) c
      WHERE r.id = ${runId}::uuid`;
  }

  private upsertResult(tx: Tx, runId: string, r: { key: string; ip: string | null; outcome: string; assetId: string | null; matchedBy: string | null; facts: object; changes: object; message: string | null }) {
    // On retry keep the first meaningful outcome: a re-sent host reconciles as "unchanged".
    return tx.$executeRaw`
      INSERT INTO discovery_results (run_id, result_key, ip, outcome, asset_id, matched_by, facts, changes, message)
      VALUES (${runId}::uuid, ${r.key}, ${r.ip}::inet, ${r.outcome}::discovery_outcome, ${r.assetId}::uuid, ${r.matchedBy},
              ${JSON.stringify(r.facts)}::jsonb, ${JSON.stringify(r.changes)}::jsonb, ${r.message})
      ON CONFLICT (run_id, result_key) DO UPDATE SET
        outcome = CASE WHEN discovery_results.outcome IN ('created', 'updated') AND EXCLUDED.outcome = 'unchanged'
                       THEN discovery_results.outcome ELSE EXCLUDED.outcome END,
        changes = CASE WHEN discovery_results.outcome IN ('created', 'updated') AND EXCLUDED.outcome = 'unchanged'
                       THEN discovery_results.changes ELSE EXCLUDED.changes END,
        ip = EXCLUDED.ip, asset_id = EXCLUDED.asset_id, matched_by = EXCLUDED.matched_by, facts = EXCLUDED.facts, message = EXCLUDED.message`;
  }

  async submit(runId: string, raw: SubmitHostsInput, ctx: WorkerCtx) {
    const input = SubmitHostsSchema.parse(raw);
    const [{ vrf_id: vrfId }] = await this.prisma.$transaction(async (tx) => {
      const r = await this.requireRunning(tx, runId);
      await tx.$executeRaw`
        UPDATE discovery_runs SET hosts_scanned = CASE WHEN hosts_total > 0 THEN LEAST(hosts_total, hosts_scanned + ${input.scannedDelta}) ELSE hosts_scanned + ${input.scannedDelta} END,
               lease_expires_at = now() + make_interval(secs => ${LEASE_SECONDS})
        WHERE id = ${runId}::uuid`;
      return [r];
    }, TX_OPTIONS);

    const summary = { created: 0, updated: 0, unchanged: 0, conflict: 0, failed: 0 };
    for (const failure of input.failures) {
      // A sweep reports the address; an inventory job reports the endpoint (a URL, region or subscription).
      const ip = isIp(failure.ip) ? parseIp(failure.ip).ip : null;
      await this.upsertResult(this.prisma, runId, { key: ip ?? failure.ip, ip, outcome: failure.outcome, assetId: null, matchedBy: null, facts: {}, changes: {}, message: failure.message });
      summary.failed++;
    }
    for (const host of input.hosts) {
      const facts = { ...host, ip: host.ip ? parseIp(host.ip).ip : undefined };
      const key = facts.externalId ?? facts.ip!;
      let res;
      try {
        res = await this.reconciler.reconcile(facts, { ...ctx, runId, vrfId });
      } catch (err) {
        // One malformed host must not sink the batch; record it and move on.
        this.log.warn(`reconcile ${key} failed: ${(err as Error).message}`);
        res = { outcome: 'error' as const, assetId: null, matchedBy: null, changes: {}, message: `reconcile failed: ${(err as Error).message.slice(0, 300)}` };
      }
      // Session lists can be thousands long: keep only the grouped outbound endpoints for the dependency pass.
      const { connections, ...kept } = facts;
      const outbound = outboundDependencies(facts);
      await this.upsertResult(this.prisma, runId, { key, ip: facts.ip ?? null, ...res, facts: { ...kept, connectionCount: connections.length, ...(outbound.length ? { outbound } : {}) } });
      if (res.outcome === 'conflict') {
        await this.audit.emit(this.prisma, {
          type: 'discovery.conflict',
          entity: 'discovery_run',
          entityId: runId,
          dedupeKey: `discovery.conflict:${runId}:${key}`,
          requestId: ctx.requestId,
          payload: { runId, ip: facts.ip ?? null, externalId: facts.externalId ?? null, hostname: facts.hostname ?? null, assetId: res.assetId, reason: res.message, candidates: (res.changes as { candidates?: unknown }).candidates ?? [] },
        });
      }
      summary[res.outcome === 'error' ? 'failed' : res.outcome]++;
    }
    await this.recount(this.prisma, runId);
    return { accepted: input.hosts.length + input.failures.length, ...summary, leaseSeconds: LEASE_SECONDS };
  }

  private async finishTx(tx: Tx, runId: string, input: FinishRunInput) {
    await this.recount(tx, runId);
    await tx.$executeRaw`
      UPDATE discovery_runs SET status = ${input.status}::job_status, finished_at = now(), lease_expires_at = NULL, error = ${input.error ?? null}
      WHERE id = ${runId}::uuid AND status IN ('queued', 'running')`;
  }

  /** After all hosts are known: derive dependency edges from every reconciled host in the run. */
  private async dependencyPass(runId: string, ctx: WorkerCtx) {
    const rows = await this.prisma.$queryRaw<Array<{ asset_id: string; outbound: Outbound[] | null; runs_on: string | null; vrf_id: string | null }>>`
      SELECT r.asset_id, r.facts->'outbound' AS outbound, r.facts->>'runsOn' AS runs_on, j.vrf_id
      FROM discovery_results r JOIN discovery_runs d ON d.id = r.run_id JOIN discovery_jobs j ON j.id = d.job_id
      WHERE r.run_id = ${runId}::uuid AND r.asset_id IS NOT NULL AND r.outcome IN ('created', 'updated', 'unchanged')
        AND (r.facts ? 'outbound' OR r.facts ? 'runsOn')`;
    let added = 0;
    for (const r of rows) {
      try {
        if (r.outbound) added += (await this.reconciler.syncDependencies(r.asset_id, r.outbound, { ...ctx, runId, vrfId: r.vrf_id })).added;
        if (r.runs_on && (await this.reconciler.syncRunsOn(r.asset_id, r.runs_on, { ...ctx, runId }))) added++;
      } catch (e) {
        this.log.warn(`relationship pass for ${r.asset_id} failed: ${(e as Error).message}`);
      }
    }
    return added;
  }

  async finish(runId: string, input: FinishRunInput, ctx?: WorkerCtx) {
    const pending = await this.prisma.discovery_runs.findUnique({ where: { id: runId }, select: { status: true } });
    if (pending && (pending.status === 'running' || pending.status === 'queued') && ctx) await this.dependencyPass(runId, ctx);
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.discovery_runs.findUnique({ where: { id: runId } });
      if (!r) throw notFound('Discovery run', runId);
      // Idempotent: a retried finish (or one racing the sweeper) returns the final state.
      if (r.status === 'running' || r.status === 'queued') {
        await this.finishTx(tx, runId, input);
        const done = runDto(await tx.discovery_runs.findUniqueOrThrow({ where: { id: runId } }));
        const [job] = await tx.$queryRaw<Array<{ name: string }>>`SELECT name FROM discovery_jobs WHERE id = ${r.job_id}::uuid`;
        await this.audit.emit(tx, {
          type: 'discovery.run.finished',
          entity: 'discovery_run',
          entityId: runId,
          dedupeKey: `discovery.run.finished:${runId}`,
          payload: { runId, jobId: r.job_id, jobName: job?.name ?? null, status: done.status, progress: done.progress, counts: done.counts, error: done.error },
        });
        return done;
      }
      return runDto(await tx.discovery_runs.findUniqueOrThrow({ where: { id: runId } }));
    }, TX_OPTIONS);
  }
}

