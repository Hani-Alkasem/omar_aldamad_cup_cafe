import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { signToken } from '../src/modules/auth/auth.guard';
import { DiscoveryQueue } from '../src/modules/discovery/discovery.queue';
import { swapUuidEndianness } from '../src/modules/discovery/reconcile';
import { makeUser } from './fixtures';

class NoQueue extends DiscoveryQueue {
  async enqueueRun() {}
  async syncSchedule() {}
}

describe('Inventory discovery: vSphere, AWS, Azure (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prisma = new PrismaClient();
  const tokens: Record<string, string> = {};
  const vc = `vc-${randomUUID().slice(0, 6)}.lab`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DiscoveryQueue).useValue(new NoQueue()).compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    for (const role of ['admin', 'discovery_service'] as const) tokens[role] = signToken((await makeUser(prisma, role)).id);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const api = () => request(baseUrl);
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  const cred = async (body: object) => (await api().post('/api/v1/credentials').set(as('admin')).send({ name: `c-${randomUUID().slice(0, 6)}`, ...body }).expect(201)).body;

  it('validates inventory credentials and job shapes', async () => {
    await api().post('/api/v1/credentials').set(as('admin')).send({ name: 'bad-aws', kind: 'aws', secret: { accessKeyId: 'nope', secretAccessKey: 'x'.repeat(40) } }).expect(400);
    await cred({ kind: 'aws', secret: { accessKeyId: 'AKIAEXAMPLEEXAMPLE12', secretAccessKey: 'x'.repeat(40) } });
    await cred({ kind: 'azure', secret: { tenantId: randomUUID(), clientId: randomUUID(), clientSecret: 'secret-123' } });
    const vs = await cred({ kind: 'vsphere', username: 'svc@vsphere.local', secret: { password: 'pw' } });
    const post = (body: object) => api().post('/api/v1/discovery/jobs').set(as('admin')).send({ name: `j-${randomUUID().slice(0, 6)}`, protocol: 'vsphere', credentialIds: [vs.id], ...body });
    expect((await post({ endpoints: ['http://vc.lab'] }).expect(400)).body.message).toMatch(/https:\/\/vcenter/);
    expect((await post({ targets: ['10.0.0.0/24'], endpoints: ['https://vc.lab'] }).expect(400)).body.message).toMatch(/endpoints, not targets/);
    expect((await post({}).expect(400)).body.message).toMatch(/at least one endpoint/);
    await post({ protocol: 'aws', endpoints: ['eu-west-1'] }).expect(422); // vSphere credential on an AWS job
    const ok = (await post({ endpoints: ['https://vc.lab/'] }).expect(201)).body;
    expect(ok).toMatchObject({ protocol: 'vsphere', endpoints: ['https://vc.lab'], targets: [] });
  });

  it('links VMs to hosts, converges with SSH on the swapped SMBIOS UUID, and follows a vMotion', async () => {
    const vs = await cred({ kind: 'vsphere', username: 'svc@vsphere.local', secret: { password: 'pw' } });
    const job = (await api().post('/api/v1/discovery/jobs').set(as('admin')).send({ name: `vc-${vc}`, protocol: 'vsphere', endpoints: [`https://${vc}`], credentialIds: [vs.id] }).expect(201)).body;
    const run = async (hosts: object[], failures: object[] = []) => {
      const r = (await api().post(`/api/v1/discovery/jobs/${job.id}/run`).set(as('admin')).expect(202)).body;
      const spec = (await api().post(`/api/v1/internal/discovery/runs/${r.id}/claim`).set(as('discovery_service')).expect(200)).body;
      expect(spec).toMatchObject({ protocol: 'vsphere', endpoints: [`https://${vc}`], targets: [] });
      await api().post(`/api/v1/internal/discovery/runs/${r.id}/hosts`).set(as('discovery_service')).send({ scannedDelta: hosts.length, hosts, failures }).expect(200);
      return (await api().post(`/api/v1/internal/discovery/runs/${r.id}/finish`).set(as('discovery_service')).send({ status: 'succeeded' }).expect(200)).body;
    };
    const biosUuid = randomUUID();
    const host = (h: string) => ({ externalId: `vsphere:${vc}:${h}`, protocol: 'vsphere', hostname: `${h}.${vc}`, os: 'VMware ESXi', cloud: { provider: 'vsphere', kind: 'host' } });
    const vm = (onHost: string) => ({ externalId: `vsphere:${vc}:vm-42`, runsOn: `vsphere:${vc}:${onHost}`, protocol: 'vsphere', hostname: 'db-42', systemUuid: biosUuid, isVirtual: true, cpuCores: 8, memoryGb: 32, cloud: { provider: 'vsphere', kind: 'vm', state: 'POWERED_ON' } });

    // VM listed before its host in the same batch: the runs_on pass at finish still resolves it.
    const first = await run([vm('host-10'), host('host-10'), host('host-11')]);
    expect(first.counts).toMatchObject({ created: 3 });
    const vmAsset = await prisma.asset_external_ids.findUniqueOrThrow({ where: { external_id: `vsphere:${vc}:vm-42` }, include: { assets: true } });
    expect(vmAsset.assets).toMatchObject({ type: 'virtual_machine', name: 'db-42', system_uuid: biosUuid });
    const h10 = await prisma.asset_external_ids.findUniqueOrThrow({ where: { external_id: `vsphere:${vc}:host-10` } });
    const edge = await prisma.ci_relationships.findFirstOrThrow({ where: { source_asset_id: vmAsset.asset_id, relationship_type: 'runs_on' } });
    expect(edge).toMatchObject({ target_asset_id: h10.asset_id, source: 'discovery' });
    expect((await prisma.assets.findUniqueOrThrow({ where: { id: h10.asset_id } })).type).toBe('physical_server');

    // The guest, seen over SSH, reports the byte-swapped form of the same UUID: same asset.
    const ssh = await cred({ kind: 'ssh_password', username: 'u', secret: { password: 'p' } });
    const sweep = (await api().post('/api/v1/discovery/jobs').set(as('admin')).send({ name: `ssh-${vc}`, protocol: 'ssh', targets: ['10.99.0.0/30'], credentialIds: [ssh.id] }).expect(201)).body;
    const r2 = (await api().post(`/api/v1/discovery/jobs/${sweep.id}/run`).set(as('admin')).expect(202)).body;
    await api().post(`/api/v1/internal/discovery/runs/${r2.id}/claim`).set(as('discovery_service')).expect(200);
    const res = (await api().post(`/api/v1/internal/discovery/runs/${r2.id}/hosts`).set(as('discovery_service')).send({ scannedDelta: 1, hosts: [{ ip: '10.99.0.1', protocol: 'ssh', hostname: 'db-42', systemUuid: swapUuidEndianness(biosUuid) }] }).expect(200)).body;
    expect(res).toMatchObject({ updated: 1, created: 0 });
    const [r2row] = (await api().get(`/api/v1/discovery/runs/${r2.id}/results`).set(as('admin')).expect(200)).body;
    expect(r2row).toMatchObject({ asset: { id: vmAsset.asset_id }, matchedBy: 'system_uuid' });

    // vMotion: the next inventory puts the VM on host-11; the edge moves, it does not multiply.
    await run([host('host-10'), host('host-11'), vm('host-11')]);
    const h11 = await prisma.asset_external_ids.findUniqueOrThrow({ where: { external_id: `vsphere:${vc}:host-11` } });
    const edges = await prisma.ci_relationships.findMany({ where: { source_asset_id: vmAsset.asset_id, relationship_type: 'runs_on' } });
    expect(edges.map((e) => e.target_asset_id)).toEqual([h11.asset_id]);

    // Blast radius of host-11 now includes the VM.
    const impact = (await api().get(`/api/v1/assets/${h11.asset_id}/impact`).set(as('admin')).expect(200)).body;
    expect(impact.assets.map((a: { id: string }) => a.id)).toContain(vmAsset.asset_id);
  });

  it('records endpoint failures and IP-less results by key', async () => {
    const vs = await cred({ kind: 'vsphere', username: 'svc@vsphere.local', secret: { password: 'pw' } });
    const job = (await api().post('/api/v1/discovery/jobs').set(as('admin')).send({ name: `fail-${vc}`, protocol: 'vsphere', endpoints: ['https://down.lab', 'https://up.lab'], credentialIds: [vs.id] }).expect(201)).body;
    const r = (await api().post(`/api/v1/discovery/jobs/${job.id}/run`).set(as('admin')).expect(202)).body;
    await api().post(`/api/v1/internal/discovery/runs/${r.id}/claim`).set(as('discovery_service')).expect(200);
    await api().post(`/api/v1/internal/discovery/runs/${r.id}/hosts`).set(as('discovery_service')).send({
      scannedDelta: 1,
      hosts: [{ externalId: 'vsphere:up.lab:vm-7', protocol: 'vsphere', hostname: 'no-tools-vm', cloud: { provider: 'vsphere', kind: 'vm' } }],
      failures: [{ ip: 'https://down.lab', outcome: 'error', message: 'connect ECONNREFUSED' }],
    }).expect(200);
    const results = (await api().get(`/api/v1/discovery/runs/${r.id}/results`).set(as('admin')).expect(200)).body;
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ ip: null, key: 'vsphere:up.lab:vm-7', outcome: 'created' }),
      expect.objectContaining({ ip: null, key: 'https://down.lab', outcome: 'error', message: 'connect ECONNREFUSED' }),
    ]));
  });
});
