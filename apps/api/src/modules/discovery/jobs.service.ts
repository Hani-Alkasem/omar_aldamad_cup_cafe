import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { checkJobScope, isInventoryProtocol, PROTOCOL_KINDS, type CreateJobInput, type DiscoveryProtocol, type UpdateJobInput } from '@itam/shared';
import { Prisma } from '@prisma/client';
import parser from 'cron-parser';
import { sqlStateOf, toDomainError } from '../../common/db-errors';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { DiscoveryQueue } from './discovery.queue';
import { normaliseTargets } from './targets';

type Ctx = { user: AuthUser; requestId?: string };

interface JobRow {
  id: string;
  name: string;
  protocol: DiscoveryProtocol;
  targets: string[];
  endpoints: string[];
  vrf_id: string | null;
  max_hosts: number;
  schedule_cron: string | null;
  is_enabled: boolean;
  options: Record<string, unknown>;
  last_run_at: Date | null;
  last_run_status: string;
  created_at: Date;
  updated_at: Date;
  credentials: Array<{ id: string; name: string; kind: string }>;
}

const JOB_SELECT = `
  SELECT j.id, j.name, j.protocol, j.targets::text[] AS targets, j.endpoints, j.vrf_id, j.max_hosts, j.schedule_cron, j.is_enabled,
         j.options, j.last_run_at, j.last_run_status, j.created_at, j.updated_at,
         COALESCE((SELECT json_agg(json_build_object('id', c.id, 'name', c.name, 'kind', c.kind) ORDER BY jc.position)
                   FROM job_credentials jc JOIN credentials c ON c.id = jc.credential_id WHERE jc.job_id = j.id), '[]') AS credentials
  FROM discovery_jobs j`;

/** Sweep jobs: canonical CIDRs within maxHosts. Inventory jobs: endpoints, trailing slashes dropped. */
function scopeOf(protocol: DiscoveryProtocol, targets: string[], endpoints: string[], maxHosts: number) {
  if (isInventoryProtocol(protocol)) return { cidrs: [] as string[], endpoints: [...new Set(endpoints.map((e) => e.replace(/\/$/, '')))] };
  return { cidrs: normaliseTargets(targets, maxHosts).cidrs, endpoints: [] as string[] };
}

export function nextRuns(cron: string | null, count = 3, tz = process.env.DISCOVERY_TZ ?? 'UTC'): string[] {
  if (!cron) return [];
  const it = parser.parseExpression(cron, { tz });
  return Array.from({ length: count }, () => it.next().toDate().toISOString());
}

const jobDto = (j: JobRow) => ({
  id: j.id,
  name: j.name,
  protocol: j.protocol,
  targets: j.targets,
  endpoints: j.endpoints,
  vrfId: j.vrf_id,
  maxHosts: j.max_hosts,
  scheduleCron: j.schedule_cron,
  nextRuns: j.is_enabled ? nextRuns(j.schedule_cron) : [],
  isEnabled: j.is_enabled,
  options: j.options,
  credentials: j.credentials,
  lastRunAt: j.last_run_at?.toISOString() ?? null,
  lastRunStatus: j.last_run_status,
  createdAt: j.created_at.toISOString(),
  updatedAt: j.updated_at.toISOString(),
});
export type JobDto = ReturnType<typeof jobDto>;

function validateCron(cron: string | null | undefined) {
  if (!cron) return;
  try {
    const it = parser.parseExpression(cron, { tz: process.env.DISCOVERY_TZ ?? 'UTC' });
    const a = it.next().getTime();
    const b = it.next().getTime();
    // A sweep every minute would overlap itself on any non-trivial network.
    if (b - a < 5 * 60_000) throw unprocessable('SCHEDULE_TOO_FREQUENT', 'Schedules must be at least 5 minutes apart');
  } catch (e) {
    if (toDomainError(e)) throw e;
    throw unprocessable('SCHEDULE_INVALID', `"${cron}" is not a valid cron expression`);
  }
}

@Injectable()
export class JobsService implements OnApplicationBootstrap {
  private readonly log = new Logger('DiscoveryJobs');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly queue: DiscoveryQueue,
  ) {}

  /** Redis is the scheduler's state; Postgres is the truth. Re-assert every enabled schedule at boot. */
  onApplicationBootstrap() {
    if (process.env.DISCOVERY_SYNC_SCHEDULES === 'false') return;
    // Background: a Redis outage must not delay or fail API startup.
    void this.syncAllSchedules().catch((e) => this.log.warn(`schedule sync failed: ${e.message}`));
  }

  async syncAllSchedules() {
    const jobs = await this.prisma.$queryRaw<Array<{ id: string; schedule_cron: string | null; is_enabled: boolean }>>`SELECT id, schedule_cron, is_enabled FROM discovery_jobs`;
    for (const j of jobs) {
      await this.queue.syncSchedule(j.id, j.is_enabled ? j.schedule_cron : null).catch((e) => this.log.warn(`schedule sync for ${j.id} failed: ${e.message}`));
    }
  }

  private async row(tx: Tx, id: string) {
    const [r] = await tx.$queryRawUnsafe<JobRow[]>(`${JOB_SELECT} WHERE j.id = $1::uuid`, id);
    return r;
  }

  async list() {
    return (await this.prisma.$queryRawUnsafe<JobRow[]>(`${JOB_SELECT} ORDER BY j.name`)).map(jobDto);
  }

  async get(id: string) {
    const r = await this.row(this.prisma, id);
    if (!r) throw notFound('Discovery job', id);
    return jobDto(r);
  }

  private async setCredentials(tx: Tx, jobId: string, protocol: DiscoveryProtocol, ids: string[]) {
    if (new Set(ids).size !== ids.length) throw unprocessable('CREDENTIAL_DUPLICATE', 'A credential is listed twice');
    const creds = await tx.credentials.findMany({ where: { id: { in: ids } }, select: { id: true, kind: true, name: true } });
    for (const id of ids) {
      const c = creds.find((x) => x.id === id);
      if (!c) throw notFound('Credential', id);
      if (!PROTOCOL_KINDS[protocol].includes(c.kind)) throw unprocessable('CREDENTIAL_KIND_MISMATCH', `${c.name} is ${c.kind}; a ${protocol} job needs ${PROTOCOL_KINDS[protocol].join(' or ')}`);
    }
    await tx.job_credentials.deleteMany({ where: { job_id: jobId } });
    await tx.job_credentials.createMany({ data: ids.map((credential_id, i) => ({ job_id: jobId, credential_id, position: i + 1 })) });
  }

  private mapWriteError(err: unknown, name?: string): never {
    const d = toDomainError(err);
    if (d?.code === 'DUPLICATE') throw conflict('JOB_EXISTS', `A discovery job named "${name}" already exists`);
    if (sqlStateOf(err) === 'KB020') throw unprocessable('CREDENTIAL_KIND_MISMATCH', d?.message ?? 'credential kind does not fit the protocol');
    throw err;
  }

  async create(input: CreateJobInput, ctx: Ctx) {
    validateCron(input.scheduleCron);
    const { cidrs, endpoints } = scopeOf(input.protocol, input.targets, input.endpoints, input.maxHosts);
    return this.prisma.$transaction(async (tx) => {
      let id: string;
      try {
        [{ id }] = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO discovery_jobs (name, protocol, targets, endpoints, vrf_id, max_hosts, schedule_cron, is_enabled, options, created_by)
          VALUES (${input.name}, ${input.protocol}::discovery_protocol, ${cidrs}::cidr[], ${endpoints}::text[], ${input.vrfId ?? null}::uuid, ${input.maxHosts},
                  ${input.scheduleCron ?? null}, ${input.isEnabled}, ${JSON.stringify(input.options)}::jsonb, ${ctx.user.id}::uuid)
          RETURNING id`;
        await this.setCredentials(tx, id, input.protocol, input.credentialIds);
      } catch (err) {
        this.mapWriteError(err, input.name);
      }
      const dto = jobDto(await this.row(tx, id));
      await this.audit.record(tx, { entity: 'discovery_job', entityId: id, action: 'create', after: dto, userId: ctx.user.id, requestId: ctx.requestId });
      // Last step inside the transaction: if Redis refuses, nothing is committed.
      await this.queue.syncSchedule(id, dto.isEnabled ? dto.scheduleCron : null);
      return dto;
    }, TX_OPTIONS);
  }

  async update(id: string, input: UpdateJobInput, ctx: Ctx) {
    validateCron(input.scheduleCron);
    return this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM discovery_jobs WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked) throw notFound('Discovery job', id);
      const before = jobDto(await this.row(tx, id));
      const protocol = input.protocol ?? before.protocol;
      const maxHosts = input.maxHosts ?? before.maxHosts;
      const scopeChanged = input.targets || input.endpoints || input.maxHosts || input.protocol;
      if (scopeChanged) {
        const issues: string[] = [];
        checkJobScope({ protocol, targets: input.targets ?? (input.protocol && input.protocol !== before.protocol ? [] : before.targets), endpoints: input.endpoints ?? (input.protocol && input.protocol !== before.protocol ? [] : before.endpoints) }, { addIssue: (i: { message?: string }) => issues.push(i.message ?? 'invalid') } as never);
        if (issues.length) throw unprocessable('JOB_SCOPE_INVALID', issues.join('; '));
      }
      const scope = scopeChanged ? scopeOf(protocol, input.targets ?? (isInventoryProtocol(protocol) ? [] : before.targets), input.endpoints ?? (isInventoryProtocol(protocol) ? before.endpoints : []), maxHosts) : null;
      const targets = scope?.cidrs ?? null;
      const endpoints = scope?.endpoints ?? null;
      try {
        // Credentials go first when the protocol changes: the trigger refuses a protocol switch over stale ones.
        if (input.protocol && input.protocol !== before.protocol) {
          if (!input.credentialIds) throw unprocessable('CREDENTIALS_REQUIRED', 'Changing the protocol needs a new credentialIds list');
          await tx.job_credentials.deleteMany({ where: { job_id: id } });
        }
        await tx.$executeRaw`
          UPDATE discovery_jobs SET
            name = COALESCE(${input.name ?? null}, name),
            protocol = ${protocol}::discovery_protocol,
            targets = COALESCE(${targets}::cidr[], targets),
            endpoints = COALESCE(${endpoints}::text[], endpoints),
            vrf_id = CASE WHEN ${input.vrfId !== undefined} THEN ${input.vrfId ?? null}::uuid ELSE vrf_id END,
            max_hosts = ${maxHosts},
            schedule_cron = CASE WHEN ${input.scheduleCron !== undefined} THEN ${input.scheduleCron ?? null} ELSE schedule_cron END,
            is_enabled = COALESCE(${input.isEnabled ?? null}::boolean, is_enabled),
            options = COALESCE(${input.options ? JSON.stringify(input.options) : null}::jsonb, options)
          WHERE id = ${id}::uuid`;
        if (input.credentialIds) await this.setCredentials(tx, id, protocol, input.credentialIds);
      } catch (err) {
        this.mapWriteError(err, input.name);
      }
      const after = jobDto(await this.row(tx, id));
      await this.audit.record(tx, { entity: 'discovery_job', entityId: id, action: 'update', before, after, userId: ctx.user.id, requestId: ctx.requestId });
      if (after.scheduleCron !== before.scheduleCron || after.isEnabled !== before.isEnabled) {
        await this.queue.syncSchedule(id, after.isEnabled ? after.scheduleCron : null);
      }
      return after;
    }, TX_OPTIONS);
  }

  async remove(id: string, ctx: Ctx) {
    await this.prisma.$transaction(async (tx) => {
      const r = await this.row(tx, id);
      if (!r) throw notFound('Discovery job', id);
      const [active] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM discovery_runs WHERE job_id = ${id}::uuid AND status IN ('queued', 'running')`;
      if (active) throw conflict('RUN_IN_PROGRESS', 'Wait for the current run to finish before deleting the job', { runId: active.id });
      await tx.$executeRaw`DELETE FROM discovery_jobs WHERE id = ${id}::uuid`;
      await this.audit.record(tx, { entity: 'discovery_job', entityId: id, action: 'delete', before: jobDto(r), userId: ctx.user.id, requestId: ctx.requestId });
      await this.queue.syncSchedule(id, null);
    }, TX_OPTIONS);
  }

  /**
   * Create a queued run. The partial unique index `discovery_runs_one_active` is the race-proof
   * guard: two clicks, or a click racing the scheduler, yield one run and one 409.
   */
  async createRun(jobId: string, trigger: 'manual' | 'schedule', ctx: { userId: string; requestId?: string }, enqueue: boolean) {
    const created = await this.prisma.$transaction(async (tx) => {
      // Row lock serialises run creation per job, so the active-run check below is exact.
      const [job] = await tx.$queryRaw<Array<{ is_enabled: boolean; name: string }>>`SELECT is_enabled, name FROM discovery_jobs WHERE id = ${jobId}::uuid FOR UPDATE`;
      if (!job) throw notFound('Discovery job', jobId);
      if (!job.is_enabled) throw conflict('JOB_DISABLED', `${job.name} is disabled`);
      const [active] = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM discovery_runs WHERE job_id = ${jobId}::uuid AND status IN ('queued', 'running')`;
      if (active) throw conflict('RUN_IN_PROGRESS', `${job.name} is already queued or running`, { runId: active.id });
      let run: { id: string };
      try {
        [run] = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO discovery_runs (job_id, trigger, requested_by) VALUES (${jobId}::uuid, ${trigger}::run_trigger, ${ctx.userId}::uuid) RETURNING id`;
      } catch (err) {
        // Backstop for writers that bypass this lock (the transaction is aborted, so no follow-up query).
        if (toDomainError(err)?.code === 'DUPLICATE') throw conflict('RUN_IN_PROGRESS', `${job.name} is already queued or running`);
        throw err;
      }
      await this.audit.record(tx, { entity: 'discovery_run', entityId: run.id, action: 'create', after: { jobId, trigger }, userId: ctx.userId, requestId: ctx.requestId });
      return run;
    }, TX_OPTIONS);
    // Enqueue only after commit: a worker can pick the job up within milliseconds and must find the run.
    // If Redis refuses, fail the run so it does not block the job, and surface the 503.
    if (enqueue) {
      try {
        await this.queue.enqueueRun(jobId, created.id);
      } catch (err) {
        await this.prisma.$executeRaw`
          UPDATE discovery_runs SET status = 'failed', finished_at = now(), error = 'job queue unavailable when the run was requested'
          WHERE id = ${created.id}::uuid AND status = 'queued'`;
        throw err;
      }
    }
    return this.getRun(created.id);
  }

  /**
   * After a confirmed reinstall: forget the recorded SSH host key so the next run records the new one.
   * Until then every run reports the host as a conflict and leaves the asset untouched.
   */
  async acceptHostKey(assetId: string, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const a = await tx.assets.findUnique({ where: { id: assetId }, select: { custom_fields: true } });
      if (!a) throw notFound('Asset', assetId);
      const custom = (a.custom_fields ?? {}) as Record<string, unknown>;
      const discovery = { ...((custom.discovery ?? {}) as Record<string, unknown>) };
      const previous = discovery.sshHostKey ?? null;
      if (!previous) return { assetId, cleared: null };
      delete discovery.sshHostKey;
      await tx.assets.update({ where: { id: assetId }, data: { custom_fields: { ...custom, discovery } as Prisma.InputJsonObject } });
      await this.audit.record(tx, { entity: 'asset', entityId: assetId, action: 'update', before: { sshHostKey: previous }, after: { sshHostKey: null }, userId: ctx.user.id, requestId: ctx.requestId });
      return { assetId, cleared: previous };
    }, TX_OPTIONS);
  }

  async listRuns(jobId: string, limit = 20) {
    await this.get(jobId);
    const rows = await this.prisma.discovery_runs.findMany({ where: { job_id: jobId }, orderBy: { queued_at: 'desc' }, take: Math.min(Math.max(limit, 1), 100) });
    return rows.map(runDto);
  }

  async getRun(id: string, tx: Tx = this.prisma) {
    const r = await tx.discovery_runs.findUnique({ where: { id } });
    if (!r) throw notFound('Discovery run', id);
    return runDto(r);
  }

  async results(runId: string, outcome?: string) {
    await this.getRun(runId);
    const rows = await this.prisma.$queryRaw<Array<{ id: string; ip: string | null; result_key: string; outcome: string; asset_id: string | null; asset_name: string | null; matched_by: string | null; changes: unknown; message: string | null; facts: Record<string, unknown> }>>`
      SELECT r.id, host(r.ip) AS ip, r.result_key, r.outcome, r.asset_id, a.name AS asset_name, r.matched_by, r.changes, r.message, r.facts
      FROM discovery_results r LEFT JOIN assets a ON a.id = r.asset_id
      WHERE r.run_id = ${runId}::uuid AND (${outcome ?? null}::discovery_outcome IS NULL OR r.outcome = ${outcome ?? null}::discovery_outcome)
      ORDER BY r.ip NULLS LAST, r.result_key`;
    return rows.map((r) => ({
      id: r.id,
      ip: r.ip,
      key: r.result_key,
      outcome: r.outcome,
      asset: r.asset_id ? { id: r.asset_id, name: r.asset_name } : null,
      matchedBy: r.matched_by,
      changes: r.changes,
      message: r.message,
      hostname: (r.facts.hostname as string | undefined) ?? null,
      os: (r.facts.os as string | undefined) ?? (r.facts.sysDescr as string | undefined)?.slice(0, 120) ?? null,
    }));
  }
}

export const runDto = (r: {
  id: string; job_id: string; trigger: string; status: string; queued_at: Date; started_at: Date | null; finished_at: Date | null;
  hosts_total: number; hosts_scanned: number; hosts_responded: number; created_count: number; updated_count: number;
  unchanged_count: number; conflict_count: number; failed_count: number; error: string | null;
}) => ({
  id: r.id,
  jobId: r.job_id,
  trigger: r.trigger,
  status: r.status,
  queuedAt: r.queued_at.toISOString(),
  startedAt: r.started_at?.toISOString() ?? null,
  finishedAt: r.finished_at?.toISOString() ?? null,
  progress: { total: r.hosts_total, scanned: r.hosts_scanned, responded: r.hosts_responded },
  counts: { created: r.created_count, updated: r.updated_count, unchanged: r.unchanged_count, conflict: r.conflict_count, failed: r.failed_count },
  error: r.error,
});
