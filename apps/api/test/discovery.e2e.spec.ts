import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { sqlStateOf } from '../src/common/db-errors';
import { signToken } from '../src/modules/auth/auth.guard';
import { DiscoveryQueue, queueUnavailable } from '../src/modules/discovery/discovery.queue';
import { RunsService } from '../src/modules/discovery/runs.service';
import { makeUser } from './fixtures';

class FakeQueue extends DiscoveryQueue {
  runs: Array<{ jobId: string; runId: string }> = [];
  schedules = new Map<string, string | null>();
  down = false;
  /** Set by the test: lets it assert the run row is already committed when the worker could see it. */
  onEnqueue?: (runId: string) => Promise<void>;
  async enqueueRun(jobId: string, runId: string) {
    if (this.down) throw queueUnavailable(new Error('connection refused'));
    await this.onEnqueue?.(runId);
    this.runs.push({ jobId, runId });
  }
  async syncSchedule(jobId: string, cron: string | null) {
    this.schedules.set(jobId, cron);
  }
}

describe('Discovery (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prisma = new PrismaClient();
  const queue = new FakeQueue();
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DiscoveryQueue).useValue(queue).compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    for (const role of ['admin', 'dc_technician', 'network_engineer', 'auditor', 'discovery_service'] as const) {
      tokens[role] = signToken((await makeUser(prisma, role)).id);
    }
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const api = () => request(baseUrl);
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  const uniq = () => randomUUID().slice(0, 8);
  const worker = () => as('discovery_service');

  const sshCred = async (password = 'correct horse battery staple') =>
    (await api().post('/api/v1/credentials').set(as('admin')).send({ name: `ssh-${uniq()}`, kind: 'ssh_password', username: 'discovery', secret: { password } }).expect(201)).body;
  const snmpCred = async () =>
    (await api().post('/api/v1/credentials').set(as('admin')).send({ name: `snmp-${uniq()}`, kind: 'snmp_v2c', secret: { community: 'n0t-public' } }).expect(201)).body;
  const job = async (credentialIds: string[], extra: Record<string, unknown> = {}) =>
    (await api().post('/api/v1/discovery/jobs').set(as('network_engineer')).send({ name: `job-${uniq()}`, protocol: 'ssh', targets: ['10.77.0.0/28'], credentialIds, ...extra }).expect(201)).body;
  const startRun = async (jobId: string) => {
    const run = (await api().post(`/api/v1/discovery/jobs/${jobId}/run`).set(as('network_engineer')).expect(202)).body;
    const spec = (await api().post(`/api/v1/internal/discovery/runs/${run.id}/claim`).set(worker()).expect(200)).body;
    return { run, spec };
  };
  const submit = (runId: string, body: object) => api().post(`/api/v1/internal/discovery/runs/${runId}/hosts`).set(worker()).send(body);

  describe('credential vault', () => {
    it('never returns secrets and stores only ciphertext', async () => {
      const c = await sshCred('s3cr3t-pa55');
      expect(JSON.stringify(c)).not.toMatch(/s3cr3t|secret|cipher/i);
      const list = await api().get('/api/v1/credentials').set(as('admin')).expect(200);
      expect(JSON.stringify(list.body)).not.toContain('s3cr3t');
      const row = await prisma.credentials.findUniqueOrThrow({ where: { id: c.id } });
      expect(Buffer.from(row.secret_ciphertext).toString('utf8')).not.toContain('s3cr3t');
      const audit = await prisma.audit_logs.findMany({ where: { entity_id: c.id }, select: { before: true, after: true } });
      expect(JSON.stringify(audit)).not.toContain('s3cr3t');
    });

    it('validates the secret per kind and restricts access to admins', async () => {
      const bad = await api().post('/api/v1/credentials').set(as('admin')).send({ name: 'x', kind: 'ssh_key', username: 'u', secret: { privateKey: 'nope' } }).expect(400);
      expect(bad.body.code).toBe('VALIDATION_FAILED');
      await api().post('/api/v1/credentials').set(as('admin')).send({ name: 'y', kind: 'ssh_password', secret: { password: 'p' } }).expect(400);
      await api().get('/api/v1/credentials').set(as('auditor')).expect(403);
      await api().post('/api/v1/credentials').set(as('network_engineer')).send({ name: 'z', kind: 'snmp_v2c', secret: { community: 'c' } }).expect(403);
    });

    it('refuses duplicate names and deleting a credential in use', async () => {
      const c = await sshCred();
      expect((await api().post('/api/v1/credentials').set(as('admin')).send({ name: c.name.toUpperCase(), kind: 'snmp_v2c', secret: { community: 'c' } }).expect(409)).body.code).toBe('CREDENTIAL_EXISTS');
      await job([c.id]);
      expect((await api().delete(`/api/v1/credentials/${c.id}`).set(as('admin')).expect(409)).body.code).toBe('CREDENTIAL_IN_USE');
    });
  });

  describe('jobs', () => {
    it('validates targets, credential kinds and schedules', async () => {
      const ssh = await sshCred();
      const snmp = await snmpCred();
      const post = (body: object) => api().post('/api/v1/discovery/jobs').set(as('admin')).send({ name: `j-${uniq()}`, protocol: 'ssh', targets: ['10.0.0.0/24'], credentialIds: [ssh.id], ...body });
      expect((await post({ credentialIds: [snmp.id] }).expect(422)).body.code).toBe('CREDENTIAL_KIND_MISMATCH');
      expect((await post({ targets: ['10.0.0.5/24'] }).expect(422)).body.code).toBe('CIDR_HOST_BITS_SET');
      expect((await post({ targets: ['10.0.0.0/16'] }).expect(422)).body.code).toBe('TARGETS_EXCEED_MAX_HOSTS');
      expect((await post({ targets: ['2001:db8::/64'], maxHosts: 65536 }).expect(422)).body.code).toBe('TARGET_TOO_LARGE');
      expect((await post({ scheduleCron: '* * * * *' }).expect(422)).body.code).toBe('SCHEDULE_TOO_FREQUENT');
      expect((await post({ scheduleCron: '61 * * * *' }).expect(422)).body.code).toBe('SCHEDULE_INVALID');
      await post({}).set(as('dc_technician')).expect(403);
    });

    it('normalises targets, syncs the schedule, and unschedules when disabled', async () => {
      const ssh = await sshCred();
      const j = await job([ssh.id], { targets: ['10.78.0.0/24', '10.78.1.7', '10.78.0.0/24'], maxHosts: 300, scheduleCron: '0 2 * * *' });
      expect(j.targets).toEqual(['10.78.0.0/24', '10.78.1.7/32']);
      expect(j.nextRuns).toHaveLength(3);
      expect(queue.schedules.get(j.id)).toBe('0 2 * * *');
      const off = await api().patch(`/api/v1/discovery/jobs/${j.id}`).set(as('admin')).send({ isEnabled: false }).expect(200);
      expect(off.body.nextRuns).toEqual([]);
      expect(queue.schedules.get(j.id)).toBeNull();
      expect((await api().post(`/api/v1/discovery/jobs/${j.id}/run`).set(as('admin')).expect(409)).body.code).toBe('JOB_DISABLED');
    });

    it('allows one active run per job', async () => {
      const j = await job([(await sshCred()).id]);
      const first = await api().post(`/api/v1/discovery/jobs/${j.id}/run`).set(as('admin')).expect(202);
      expect(queue.runs.at(-1)).toEqual({ jobId: j.id, runId: first.body.id });
      const again = await api().post(`/api/v1/discovery/jobs/${j.id}/run`).set(as('admin')).expect(409);
      expect(again.body).toMatchObject({ code: 'RUN_IN_PROGRESS', details: { runId: first.body.id } });
      expect((await api().delete(`/api/v1/discovery/jobs/${j.id}`).set(as('admin')).expect(409)).body.code).toBe('RUN_IN_PROGRESS');
    });

    it('enqueues only after the run is committed, and fails the run if Redis refuses', async () => {
      const j = await job([(await sshCred()).id]);
      let visible: unknown;
      queue.onEnqueue = async (runId) => {
        // A separate connection, like a worker's claim: the run must already be committed.
        const other = new PrismaClient();
        visible = await other.discovery_runs.findUnique({ where: { id: runId }, select: { status: true } });
        await other.$disconnect();
      };
      await api().post(`/api/v1/discovery/jobs/${j.id}/run`).set(as('admin')).expect(202);
      queue.onEnqueue = undefined;
      expect(visible).toEqual({ status: 'queued' });

      const j2 = await job([(await sshCred()).id]);
      queue.down = true;
      const res = await api().post(`/api/v1/discovery/jobs/${j2.id}/run`).set(as('admin')).expect(503);
      queue.down = false;
      expect(res.body.code).toBe('QUEUE_UNAVAILABLE');
      const runs = (await api().get(`/api/v1/discovery/jobs/${j2.id}/runs`).set(as('auditor')).expect(200)).body;
      expect(runs).toMatchObject([{ status: 'failed', error: expect.stringMatching(/queue unavailable/) }]);
      // The job is not blocked by the failed attempt.
      await api().post(`/api/v1/discovery/jobs/${j2.id}/run`).set(as('admin')).expect(202);
    });

    it('DB refuses a credential of the wrong kind (KB020)', async () => {
      const j = await job([(await sshCred()).id]);
      const s = await snmpCred();
      const err = await prisma.job_credentials.create({ data: { job_id: j.id, credential_id: s.id, position: 9 } }).catch((e) => e);
      expect(sqlStateOf(err)).toBe('KB020');
    });
  });

  describe('service account isolation', () => {
    it('worker token cannot use public routes; people cannot use internal ones', async () => {
      await api().get('/api/v1/assets').set(worker()).expect(403);
      await api().get('/api/v1/credentials').set(worker()).expect(403);
      await api().post(`/api/v1/internal/discovery/runs/${randomUUID()}/claim`).set(as('admin')).expect(403);
    });
  });

  describe('worker protocol and reconciliation', () => {
    const MAC = '3c:ec:ef:10:20:30';
    const host = (extra: Record<string, unknown> = {}) => ({
      ip: '10.77.0.5',
      protocol: 'ssh',
      hostname: 'web-07.dc.example.com',
      serialNumber: `SN-${uniq()}`,
      systemUuid: randomUUID(),
      vendor: 'Dell Inc.',
      model: 'PowerEdge R660',
      os: 'Ubuntu 24.04.1 LTS',
      cpuCores: 32,
      memoryGb: 256,
      disks: [{ name: 'nvme0n1', sizeGb: 1920, model: 'Dell Ent NVMe' }],
      interfaces: [{ name: 'eno1', mac: MAC, speedMbps: 25000 }],
      sshHostKey: `SHA256:${'A'.repeat(43)}`,
      ...extra,
    });

    beforeAll(async () => {
      await prisma.$executeRaw`INSERT INTO subnets (cidr, name) VALUES ('10.77.0.0/24'::cidr, 'discovery test') ON CONFLICT DO NOTHING`;
    });

    it('claim hands out decrypted credentials once and audits the access', async () => {
      const cred = await sshCred('pa55w0rd!');
      const j = await job([cred.id]);
      const { run, spec } = await startRun(j.id);
      expect(spec).toMatchObject({ runId: run.id, protocol: 'ssh', targets: ['10.77.0.0/28'], credentials: [{ id: cred.id, kind: 'ssh_password', username: 'discovery', secret: { password: 'pa55w0rd!' } }] });
      expect((await api().post(`/api/v1/internal/discovery/runs/${run.id}/claim`).set(worker()).expect(409)).body.code).toBe('RUN_NOT_CLAIMABLE');
      const access = await prisma.audit_logs.findMany({ where: { entity_id: cred.id, action: 'access' } });
      expect(access).toHaveLength(1);
      expect((await api().get(`/api/v1/discovery/runs/${run.id}`).set(as('auditor')).expect(200)).body).toMatchObject({ status: 'running', progress: { total: 14 } });
    });

    it('creates, then matches idempotently, flags conflicts, and finishes with exact counts', async () => {
      const j = await job([(await sshCred()).id]);
      const { run } = await startRun(j.id);
      const h = host();

      const first = (await submit(run.id, { scannedDelta: 10, hosts: [h], failures: [{ ip: '10.77.0.9', outcome: 'auth_failed', message: 'all credentials rejected' }] }).expect(200)).body;
      expect(first).toMatchObject({ created: 1, failed: 1 });
      // A retried batch (worker lost the response) must not change outcomes or counts.
      expect((await submit(run.id, { scannedDelta: 0, hosts: [h] }).expect(200)).body).toMatchObject({ unchanged: 1 });

      const results = (await api().get(`/api/v1/discovery/runs/${run.id}/results`).set(as('auditor')).expect(200)).body;
      const created = results.find((r: { ip: string }) => r.ip === '10.77.0.5');
      expect(created).toMatchObject({ outcome: 'created', hostname: 'web-07.dc.example.com', asset: { name: 'web-07' } });

      const assetId = created.asset.id;
      const asset = (await api().get(`/api/v1/assets/${assetId}`).set(as('auditor')).expect(200)).body;
      expect(asset).toMatchObject({ type: 'physical_server', serialNumber: h.serialNumber, status: 'active' });
      const comps = (await api().get(`/api/v1/assets/${assetId}/components`).set(as('auditor')).expect(200)).body;
      expect(comps.summary).toMatchObject({ cpuCores: 32, memoryGb: 256, diskGb: 1920 });
      const ports = (await api().get(`/api/v1/assets/${assetId}/ports`).set(as('auditor')).expect(200)).body;
      expect(ports).toMatchObject([{ portName: 'eno1', macAddress: MAC, speedMbps: 25000 }]);
      const [ip] = await prisma.$queryRaw<Array<{ asset_id: string; status: string }>>`SELECT asset_id, status FROM ip_addresses WHERE ip = '10.77.0.5'::inet`;
      expect(ip).toMatchObject({ asset_id: assetId, status: 'assigned' });

      // Same MAC, different serial: a NIC moved, or a clone. Never merged silently.
      const clash = (await submit(run.id, { scannedDelta: 1, hosts: [host({ ip: '10.77.0.6', serialNumber: 'OTHER-SERIAL', systemUuid: randomUUID() })] }).expect(200)).body;
      expect(clash.conflict).toBe(1);

      const done = (await api().post(`/api/v1/internal/discovery/runs/${run.id}/finish`).set(worker()).send({ status: 'succeeded' }).expect(200)).body;
      expect(done).toMatchObject({ status: 'succeeded', progress: { scanned: 11, responded: 3 }, counts: { created: 1, conflict: 1, failed: 1, unchanged: 0 } });
      expect((await api().post(`/api/v1/internal/discovery/runs/${run.id}/finish`).set(worker()).send({ status: 'failed' }).expect(200)).body.status).toBe('succeeded');
      expect((await submit(run.id, { scannedDelta: 1 }).expect(409)).body.code).toBe('RUN_NOT_RUNNING');
      expect((await api().get(`/api/v1/discovery/jobs/${j.id}`).set(as('auditor')).expect(200)).body.lastRunStatus).toBe('succeeded');

      // Next run: hardware changed → updated, components replaced; hand-entered component untouched.
      await prisma.asset_components.create({ data: { asset_id: assetId, kind: 'gpu', model: 'hand-entered' } });
      const { run: run2 } = await startRun(j.id);
      const upd = (await submit(run2.id, { scannedDelta: 1, hosts: [{ ...h, memoryGb: 512 }] }).expect(200)).body;
      expect(upd.updated).toBe(1);
      const comps2 = (await api().get(`/api/v1/assets/${assetId}/components`).set(as('auditor')).expect(200)).body;
      expect(comps2.summary).toMatchObject({ memoryGb: 512, gpus: 1 });

      // Host key changed: flagged, not applied.
      const rekey = (await submit(run2.id, { scannedDelta: 0, hosts: [{ ...h, ip: '10.77.0.5', sshHostKey: `SHA256:${'B'.repeat(43)}` }] }).expect(200)).body;
      expect(rekey.conflict).toBe(1);
      // A human confirms the reinstall; the next sighting records the new key instead of conflicting.
      expect((await api().delete(`/api/v1/assets/${assetId}/discovery/ssh-host-key`).set(as('dc_technician')).expect(200)).body.cleared).toBe(h.sshHostKey);
      await api().post(`/api/v1/internal/discovery/runs/${run2.id}/finish`).set(worker()).send({ status: 'succeeded' }).expect(200);
      const { run: run3 } = await startRun(j.id);
      const accepted = (await submit(run3.id, { scannedDelta: 1, hosts: [{ ...h, memoryGb: 512, sshHostKey: `SHA256:${'B'.repeat(43)}` }] }).expect(200)).body;
      expect(accepted.updated).toBe(1);

      const audit = await prisma.audit_logs.findMany({ where: { entity_id: assetId }, orderBy: { id: 'asc' }, select: { action: true } });
      // create (asset row), update (first ports + components), update (RAM on run 2), update (key cleared), update (new key recorded).
      expect(audit.map((a) => a.action)).toEqual(['create', 'update', 'update', 'update', 'update']);
    });

    it('re-claims a run whose worker died, and the sweeper fails abandoned runs', async () => {
      const j = await job([(await sshCred()).id]);
      const { run } = await startRun(j.id);
      await prisma.discovery_runs.update({ where: { id: run.id }, data: { lease_expires_at: new Date(Date.now() - 1000) } });
      await api().post(`/api/v1/internal/discovery/runs/${run.id}/claim`).set(worker()).expect(200);

      await prisma.discovery_runs.update({ where: { id: run.id }, data: { lease_expires_at: new Date(Date.now() - 600_000) } });
      expect(await app.get(RunsService).sweep()).toBeGreaterThanOrEqual(1);
      const swept = (await api().get(`/api/v1/discovery/runs/${run.id}`).set(as('auditor')).expect(200)).body;
      expect(swept).toMatchObject({ status: 'failed', error: expect.stringMatching(/lease expired/) });
      // The job is free again.
      await api().post(`/api/v1/discovery/jobs/${j.id}/run`).set(as('admin')).expect(202);
    });

    it('scheduler path: the worker opens the run itself', async () => {
      const j = await job([(await sshCred()).id], { scheduleCron: '30 3 * * *' });
      const r = await api().post(`/api/v1/internal/discovery/jobs/${j.id}/runs`).set(worker()).expect(201);
      expect(r.body).toMatchObject({ trigger: 'schedule', status: 'queued' });
      expect((await api().post(`/api/v1/internal/discovery/jobs/${j.id}/runs`).set(worker()).expect(409)).body.code).toBe('RUN_IN_PROGRESS');
    });
  });
});
