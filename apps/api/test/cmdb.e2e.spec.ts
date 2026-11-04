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
import { makeUser } from './fixtures';

class NoQueue extends DiscoveryQueue {
  async enqueueRun() {}
  async syncSchedule() {}
}

describe('CMDB dependency mapping (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prisma = new PrismaClient();
  const tokens: Record<string, string> = {};
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(DiscoveryQueue).useValue(new NoQueue()).compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    for (const role of ['admin', 'network_engineer', 'auditor', 'discovery_service'] as const) tokens[role] = signToken((await makeUser(prisma, role)).id);
    await prisma.$executeRaw`INSERT INTO subnets (cidr, name) VALUES ('10.88.0.0/24'::cidr, 'cmdb test') ON CONFLICT DO NOTHING`;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const api = () => request(baseUrl);
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  const host = (ip: string, name: string, listeners: number[], connections: Array<[string, number, number]>) => ({
    ip,
    protocol: 'ssh',
    hostname: `${name}.example.com`,
    systemUuid: randomUUID(),
    listeners: listeners.map((port) => ({ port })),
    connections: connections.map(([remoteIp, remotePort, localPort]) => ({ remoteIp, remotePort, localPort, process: 'app' })),
  });

  // web → db:5432 and web → cache:6379; web also has an inbound client and a session to an ephemeral port on cache.
  const web = host('10.88.0.10', 'web', [22, 443], [['10.88.0.20', 5432, 51234], ['10.88.0.20', 5432, 51235], ['10.88.0.30', 6379, 51300], ['10.88.0.30', 50000, 443], ['10.88.0.99', 51000, 443], ['127.0.0.1', 5432, 51400]]);
  const db = host('10.88.0.20', 'db', [22, 5432], []);
  const cache = host('10.88.0.30', 'cache', [6379], []);

  async function runOnce(batches: object[][]) {
    const cred = (await api().post('/api/v1/credentials').set(as('admin')).send({ name: `c-${randomUUID().slice(0, 6)}`, kind: 'ssh_password', username: 'u', secret: { password: 'p' } }).expect(201)).body;
    ids.job ??= (await api().post('/api/v1/discovery/jobs').set(as('admin')).send({ name: 'cmdb-sweep', protocol: 'ssh', targets: ['10.88.0.0/24'], credentialIds: [cred.id] }).expect(201)).body.id;
    const run = (await api().post(`/api/v1/discovery/jobs/${ids.job}/run`).set(as('admin')).expect(202)).body;
    await api().post(`/api/v1/internal/discovery/runs/${run.id}/claim`).set(as('discovery_service')).expect(200);
    for (const hosts of batches) await api().post(`/api/v1/internal/discovery/runs/${run.id}/hosts`).set(as('discovery_service')).send({ scannedDelta: hosts.length, hosts }).expect(200);
    return run.id as string;
  }
  const finish = (runId: string) => api().post(`/api/v1/internal/discovery/runs/${runId}/finish`).set(as('discovery_service')).send({ status: 'succeeded' }).expect(200);
  const edge = (from: string, to: string) => prisma.ci_relationships.findFirst({ where: { source_asset_id: ids[from], target_asset_id: ids[to], relationship_type: 'depends_on' } });

  it('derives client-side dependencies at finish, even when the server was discovered later in the run', async () => {
    const runId = await runOnce([[web], [db, cache]]);
    expect(await prisma.ci_relationships.count({ where: { source: 'discovery' } })).toBe(0); // nothing before finish
    await finish(runId);
    for (const n of ['web', 'db', 'cache']) ids[n] = (await prisma.assets.findFirstOrThrow({ where: { name: n } })).id;

    expect(await edge('web', 'db')).toMatchObject({ source: 'discovery', observation_count: 1, attributes: { ports: [5432], process: 'app' } });
    // 50000 is not a port cache listens on; the inbound client 10.88.0.99 is unknown; loopback ignored.
    expect(await edge('web', 'cache')).toMatchObject({ attributes: { ports: [6379] } });
    expect(await prisma.ci_relationships.count({ where: { source: 'discovery' } })).toBe(2);

    // A retried finish does not double-count; the next run does.
    await finish(runId);
    expect((await edge('web', 'db'))?.observation_count).toBe(1);
    await finish(await runOnce([[web, db, cache]]));
    expect((await edge('web', 'db'))?.observation_count).toBe(2);
  });

  it('serves the graph in each direction and the blast radius', async () => {
    const up = (await api().get(`/api/v1/cmdb/graph?root=${ids.db}&direction=up`).set(as('auditor')).expect(200)).body;
    expect(up.nodes.map((n: { name: string }) => n.name).sort()).toEqual(['db', 'web']);
    expect(up.nodes.find((n: { isRoot: boolean }) => n.isRoot).name).toBe('db');
    expect(up.edges).toMatchObject([{ source: ids.web, target: ids.db, ports: [5432], origin: 'discovery', stale: false }]);

    const down = (await api().get(`/api/v1/cmdb/graph?root=${ids.web}&direction=down`).set(as('auditor')).expect(200)).body;
    expect(down.edges).toHaveLength(2);

    const impact = (await api().get(`/api/v1/assets/${ids.cache}/impact`).set(as('auditor')).expect(200)).body;
    expect(impact.assets).toMatchObject([{ name: 'web', depth: 1 }]);
    await api().get(`/api/v1/cmdb/graph?root=${randomUUID()}`).set(as('auditor')).expect(404);
  });

  it('manual edges are editable; discovered edges only once stale; power edges never', async () => {
    const storage = (await api().post('/api/v1/assets').set(as('admin')).send({ name: 'san-01', type: 'storage_array' }).expect(201)).body;
    const manual = await api().post('/api/v1/cmdb/relationships').set(as('network_engineer')).send({ sourceAssetId: ids.db, targetAssetId: storage.id, relationshipType: 'depends_on', ports: [3260], note: 'iSCSI LUNs' }).expect(201);
    expect(manual.body).toMatchObject({ origin: 'manual', ports: [3260] });
    expect((await api().post('/api/v1/cmdb/relationships').set(as('admin')).send({ sourceAssetId: ids.db, targetAssetId: storage.id, relationshipType: 'depends_on' }).expect(409)).body.code).toBe('RELATIONSHIP_EXISTS');
    await api().post('/api/v1/cmdb/relationships').set(as('auditor')).send({ sourceAssetId: ids.db, targetAssetId: storage.id, relationshipType: 'runs_on' }).expect(403);
    await api().post('/api/v1/cmdb/relationships').set(as('admin')).send({ sourceAssetId: ids.db, targetAssetId: ids.db, relationshipType: 'runs_on' }).expect(400);

    // Blast radius now crosses manual and discovered edges: san-01 → db → web.
    const impact = (await api().get(`/api/v1/assets/${storage.id}/impact`).set(as('auditor')).expect(200)).body;
    expect(impact.assets.map((a: { name: string; depth: number }) => [a.name, a.depth])).toEqual([['db', 1], ['web', 2]]);

    const discovered = (await edge('web', 'cache'))!;
    expect((await api().delete(`/api/v1/cmdb/relationships/${discovered.id}`).set(as('admin')).expect(409)).body.code).toBe('DISCOVERED_EDGE_ACTIVE');
    await prisma.ci_relationships.update({ where: { id: discovered.id }, data: { first_seen_at: new Date(Date.now() - 40 * 86_400_000), last_seen_at: new Date(Date.now() - 30 * 86_400_000) } });
    const hidden = (await api().get(`/api/v1/cmdb/graph?root=${ids.web}&direction=down&depth=1`).set(as('auditor')).expect(200)).body;
    expect(hidden.edges.map((e: { target: string }) => e.target)).toEqual([ids.db]);
    const shown = (await api().get(`/api/v1/cmdb/graph?root=${ids.web}&direction=down&depth=1&includeStale=true`).set(as('auditor')).expect(200)).body;
    expect(shown.edges.find((e: { id: string }) => e.id === discovered.id)).toMatchObject({ stale: true });
    await api().delete(`/api/v1/cmdb/relationships/${discovered.id}`).set(as('admin')).expect(204);

    const power = await prisma.ci_relationships.create({ data: { source_asset_id: ids.web, target_asset_id: storage.id, relationship_type: 'powered_by', source: 'power' } });
    expect((await api().delete(`/api/v1/cmdb/relationships/${power.id}`).set(as('admin')).expect(409)).body.code).toBe('POWER_EDGE_READONLY');
    await api().delete(`/api/v1/cmdb/relationships/${manual.body.id}`).set(as('network_engineer')).expect(204);
  });

  it('applications group assets, show in impact, and get a one-hop graph', async () => {
    const shop = await api().post('/api/v1/applications').set(as('network_engineer')).send({ name: 'Web shop', criticality: 'tier1', owner: 'Commerce', members: [{ assetId: ids.web, role: 'frontend' }, { assetId: ids.db, role: 'database' }] }).expect(201);
    expect(shop.body.members).toHaveLength(2);
    expect((await api().post('/api/v1/applications').set(as('admin')).send({ name: 'web SHOP' }).expect(409)).body.code).toBe('APPLICATION_EXISTS');
    await api().post('/api/v1/applications').set(as('auditor')).send({ name: 'x' }).expect(403);

    const impact = (await api().get(`/api/v1/assets/${ids.db}/impact`).set(as('auditor')).expect(200)).body;
    expect(impact.applications).toMatchObject([{ name: 'Web shop', criticality: 'tier1' }]);

    const g = (await api().get(`/api/v1/applications/${shop.body.id}/graph`).set(as('auditor')).expect(200)).body;
    expect(g.edges.length).toBeGreaterThanOrEqual(1);
    expect(g.nodes.find((n: { name: string }) => n.name === 'web').applications).toEqual(['Web shop']);

    const set = await api().put(`/api/v1/applications/${shop.body.id}/members`).set(as('admin')).send({ members: [{ assetId: ids.web }] }).expect(200);
    expect(set.body.members.map((m: { name: string }) => m.name)).toEqual(['web']);
    await api().put(`/api/v1/applications/${shop.body.id}/members`).set(as('admin')).send({ members: [{ assetId: randomUUID() }] }).expect(404);
    await api().delete(`/api/v1/applications/${shop.body.id}`).set(as('admin')).expect(204);
  });
});
