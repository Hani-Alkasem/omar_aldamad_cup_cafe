import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { signToken } from '../src/modules/auth/auth.guard';
import { makeRack, makeUser, makeVrf } from './fixtures';

describe('API (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prisma = new PrismaClient();
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    // Bind once: supertest's per-request ephemeral listener drops connections under bursts.
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    for (const role of ['admin', 'dc_technician', 'network_engineer', 'auditor'] as const) {
      tokens[role] = signToken((await makeUser(prisma, role)).id);
    }
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const api = () => request(baseUrl);
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  const server = (rackId: string, name: string, startU: number, extra: Record<string, unknown> = {}) => ({
    name,
    type: 'physical_server',
    rackId,
    startU,
    sizeU: 2,
    face: 'front',
    depth: 'full',
    ...extra,
  });

  describe('auth and RBAC', () => {
    it('health is public', async () => {
      await api().get('/api/v1/health').expect(200);
    });

    it('rejects missing and forged tokens', async () => {
      await api().get('/api/v1/assets').expect(401);
      const forged = signToken((await makeUser(prisma, 'admin')).id, 'some-other-secret-that-is-32-chars-long!');
      await api().get('/api/v1/assets').set({ Authorization: `Bearer ${forged}` }).expect(401);
    });

    it('auditors can read but not write', async () => {
      await api().get('/api/v1/assets').set(as('auditor')).expect(200);
      const res = await api().post('/api/v1/assets').set(as('auditor')).send({ name: 'x', type: 'other' }).expect(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('network engineers cannot rack hardware; technicians cannot create subnets', async () => {
      await api().post('/api/v1/assets').set(as('network_engineer')).send({ name: 'x', type: 'other' }).expect(403);
      await api().post('/api/v1/subnets').set(as('dc_technician')).send({ cidr: '10.250.0.0/24' }).expect(403);
    });
  });

  describe('assets and rack U-space', () => {
    it('creates an asset and writes an audit row in the same transaction', async () => {
      const rack = await makeRack(prisma);
      const res = await api().post('/api/v1/assets').set(as('dc_technician')).send(server(rack.id, 'web-01', 10)).expect(201);
      expect(res.body).toMatchObject({ name: 'web-01', rackId: rack.id, startU: 10, sizeU: 2, face: 'front' });

      const history = await api().get(`/api/v1/assets/${res.body.id}/history`).set(as('auditor')).expect(200);
      expect(history.body).toHaveLength(1);
      expect(history.body[0]).toMatchObject({ action: 'create', before: null });
    });

    it('returns 409 with the conflicting device and free slots on collision', async () => {
      const rack = await makeRack(prisma);
      await api().post('/api/v1/assets').set(as('admin')).send(server(rack.id, 'db-01', 20)).expect(201);
      const res = await api().post('/api/v1/assets').set(as('admin')).send(server(rack.id, 'db-02', 21)).expect(409);
      expect(res.body.code).toBe('RACK_U_CONFLICT');
      expect(res.body.message).toContain('db-01');
      expect(res.body.details.conflicts[0]).toMatchObject({ name: 'db-01', fromU: 20, toU: 21 });
      expect(res.body.details.suggestedStartU).toEqual([1, 2, 3, 4, 5]);
    });

    it('rejects a device that would run past the top of the rack', async () => {
      const rack = await makeRack(prisma, 42);
      const res = await api().post('/api/v1/assets').set(as('admin')).send(server(rack.id, 'too-high', 42)).expect(422);
      expect(res.body).toMatchObject({ code: 'RACK_U_OUT_OF_RANGE', details: { maxStartU: 41 } });
    });

    it('validates placement fields', async () => {
      const rack = await makeRack(prisma);
      const res = await api().post('/api/v1/assets').set(as('admin')).send({ name: 'x', type: 'switch', rackId: rack.id }).expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.message).toMatch(/startU/);
    });

    it('concurrent placements into the same slot: exactly one wins', async () => {
      const rack = await makeRack(prisma);
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) => api().post('/api/v1/assets').set(as('admin')).send(server(rack.id, `race-${i}`, 30))),
      );
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    });

    it('moves a device with PATCH, ignoring its own old slot, and audits the diff', async () => {
      const rack = await makeRack(prisma);
      const created = await api().post('/api/v1/assets').set(as('admin')).send(server(rack.id, 'mover', 5)).expect(201);
      // Shift up by one U: overlaps its own old position, which must not count as a conflict.
      const moved = await api().patch(`/api/v1/assets/${created.body.id}`).set(as('dc_technician')).send({ startU: 6 }).expect(200);
      expect(moved.body.startU).toBe(6);

      const history = await api().get(`/api/v1/assets/${created.body.id}/history`).set(as('auditor')).expect(200);
      expect(history.body[0]).toMatchObject({ action: 'update', changedFields: ['startU'] });
      expect(history.body[0].before.startU).toBe(5);
      expect(history.body[0].after.startU).toBe(6);
    });

    it('PATCH into an occupied slot is rejected and leaves the device in place', async () => {
      const rack = await makeRack(prisma);
      await api().post('/api/v1/assets').set(as('admin')).send(server(rack.id, 'fixed', 10)).expect(201);
      const other = await api().post('/api/v1/assets').set(as('admin')).send(server(rack.id, 'other', 1)).expect(201);
      await api().patch(`/api/v1/assets/${other.body.id}`).set(as('admin')).send({ startU: 11 }).expect(409);
      const still = await api().get(`/api/v1/assets/${other.body.id}`).set(as('auditor')).expect(200);
      expect(still.body.startU).toBe(1);
    });

    it('unracking clears the position; delete is audited', async () => {
      const rack = await makeRack(prisma);
      const a = await api().post('/api/v1/assets').set(as('admin')).send(server(rack.id, 'leaver', 3)).expect(201);
      const out = await api().patch(`/api/v1/assets/${a.body.id}`).set(as('admin')).send({ rackId: null }).expect(200);
      expect(out.body).toMatchObject({ rackId: null, startU: null, face: null });
      await api().delete(`/api/v1/assets/${a.body.id}`).set(as('admin')).expect(204);
      await api().get(`/api/v1/assets/${a.body.id}`).set(as('admin')).expect(404);
      const history = await api().get(`/api/v1/assets/${a.body.id}/history`).set(as('auditor')).expect(200);
      expect(history.body.map((h: { action: string }) => h.action)).toEqual(['delete', 'update', 'create']);
    });

    it('serves the rack elevation and free space', async () => {
      const rack = await makeRack(prisma, 10);
      await api().post('/api/v1/assets').set(as('admin')).send(server(rack.id, 'full', 1)).expect(201);
      await api().post('/api/v1/assets').set(as('admin')).send({ ...server(rack.id, 'rear-half', 5), sizeU: 1, face: 'rear', depth: 'half' }).expect(201);

      const elev = await api().get(`/api/v1/racks/${rack.id}/elevation`).set(as('auditor')).expect(200);
      expect(elev.body.devices).toHaveLength(2);
      expect(elev.body.free.front).toEqual([{ fromU: 3, toU: 10 }]);
      expect(elev.body.free.rear).toEqual([{ fromU: 3, toU: 4 }, { fromU: 6, toU: 10 }]);

      const free = await api().get(`/api/v1/racks/${rack.id}/free-space?sizeU=2&depth=full`).set(as('auditor')).expect(200);
      expect(free.body.startU).toEqual([3, 6, 7, 8, 9]);
    });
  });

  describe('IPAM', () => {
    it('normalises CIDR, rejects host bits and duplicates, and nests subnets', async () => {
      const vrf = await makeVrf(prisma);
      const parent = await api().post('/api/v1/subnets').set(as('network_engineer')).send({ cidr: '10.60.0.0/16', vrfId: vrf.id }).expect(201);
      expect(parent.body).toMatchObject({ cidr: '10.60.0.0/16', family: 4, totalHosts: '65534', usedHosts: 0 });

      const bad = await api().post('/api/v1/subnets').set(as('network_engineer')).send({ cidr: '10.60.1.9/24', vrfId: vrf.id }).expect(422);
      expect(bad.body).toMatchObject({ code: 'CIDR_HOST_BITS_SET', details: { suggestion: '10.60.1.0/24' } });

      const child = await api().post('/api/v1/subnets').set(as('network_engineer')).send({ cidr: '10.60.1.0/24', vrfId: vrf.id }).expect(201);
      expect(child.body.parentId).toBe(parent.body.id);

      const dup = await api().post('/api/v1/subnets').set(as('network_engineer')).send({ cidr: '10.60.1.0/24', vrfId: vrf.id }).expect(409);
      expect(dup.body.code).toBe('SUBNET_EXISTS');

      const tree = await api().get(`/api/v1/subnets/tree?vrfId=${vrf.id}`).set(as('auditor')).expect(200);
      expect(tree.body).toHaveLength(1);
      expect(tree.body[0].children.map((c: { cidr: string }) => c.cidr)).toEqual(['10.60.1.0/24']);
    });

    it('50 concurrent allocations get 50 distinct addresses, in order', async () => {
      const vrf = await makeVrf(prisma);
      const s = await api().post('/api/v1/subnets').set(as('admin')).send({ cidr: '10.61.0.0/26', vrfId: vrf.id }).expect(201);
      const results = await Promise.all(Array.from({ length: 50 }, () => api().post(`/api/v1/subnets/${s.body.id}/allocate`).set(as('network_engineer')).send({})));
      expect(results.map((r) => r.status).filter((c) => c !== 201)).toEqual([]);
      const ips = results.map((r) => r.body.ip as string);
      expect(new Set(ips).size).toBe(50);
      const expected = Array.from({ length: 50 }, (_, i) => `10.61.0.${i + 1}`);
      expect([...ips].sort((a, b) => Number(a.split('.')[3]) - Number(b.split('.')[3]))).toEqual(expected);

      const summary = await api().get(`/api/v1/subnets/${s.body.id}`).set(as('auditor')).expect(200);
      expect(summary.body).toMatchObject({ usedHosts: 50, totalHosts: '62' });
    });

    it('returns SUBNET_FULL once exhausted and reuses released addresses first', async () => {
      const vrf = await makeVrf(prisma);
      const s = await api().post('/api/v1/subnets').set(as('admin')).send({ cidr: '10.62.0.0/29', vrfId: vrf.id }).expect(201);
      const got: Array<{ id: string; ip: string }> = [];
      for (let i = 0; i < 6; i++) got.push((await api().post(`/api/v1/subnets/${s.body.id}/allocate`).set(as('admin')).send({}).expect(201)).body);
      expect(got.map((g) => g.ip)).toEqual(['10.62.0.1', '10.62.0.2', '10.62.0.3', '10.62.0.4', '10.62.0.5', '10.62.0.6']);

      const full = await api().post(`/api/v1/subnets/${s.body.id}/allocate`).set(as('admin')).send({}).expect(409);
      expect(full.body.code).toBe('SUBNET_FULL');

      await api().delete(`/api/v1/ip-addresses/${got[2].id}`).set(as('admin')).expect(204);
      const reused = await api().post(`/api/v1/subnets/${s.body.id}/allocate`).set(as('admin')).send({}).expect(201);
      expect(reused.body.ip).toBe('10.62.0.3');
    });

    it('allocation skips ranges carved out by child subnets', async () => {
      const vrf = await makeVrf(prisma);
      const parent = await api().post('/api/v1/subnets').set(as('admin')).send({ cidr: '10.63.0.0/24', vrfId: vrf.id }).expect(201);
      await api().post('/api/v1/subnets').set(as('admin')).send({ cidr: '10.63.0.0/25', vrfId: vrf.id }).expect(201);
      const ip = await api().post(`/api/v1/subnets/${parent.body.id}/allocate`).set(as('admin')).send({}).expect(201);
      expect(ip.body.ip).toBe('10.63.0.128');
    });

    it('reserves a specific IP and rejects out-of-range, broadcast and duplicates', async () => {
      const vrf = await makeVrf(prisma);
      const s = await api().post('/api/v1/subnets').set(as('admin')).send({ cidr: '10.64.0.0/24', vrfId: vrf.id }).expect(201);
      const ok = await api().post(`/api/v1/subnets/${s.body.id}/reserve`).set(as('admin')).send({ ip: '10.64.0.10' }).expect(201);
      expect(ok.body).toMatchObject({ ip: '10.64.0.10', status: 'reserved' });
      expect((await api().post(`/api/v1/subnets/${s.body.id}/reserve`).set(as('admin')).send({ ip: '10.64.0.10' }).expect(409)).body.code).toBe('IP_IN_USE');
      expect((await api().post(`/api/v1/subnets/${s.body.id}/reserve`).set(as('admin')).send({ ip: '10.65.0.1' }).expect(422)).body.code).toBe('IP_OUTSIDE_SUBNET');
      expect((await api().post(`/api/v1/subnets/${s.body.id}/reserve`).set(as('admin')).send({ ip: '10.64.0.255' }).expect(422)).body.code).toBe('IP_RESERVED_ADDRESS');
      expect((await api().post(`/api/v1/subnets/${s.body.id}/reserve`).set(as('admin')).send({ ip: 'nope' }).expect(422)).body.code).toBe('IP_INVALID');
    });

    it('allocates in IPv6 subnets', async () => {
      const vrf = await makeVrf(prisma);
      const s = await api().post('/api/v1/subnets').set(as('admin')).send({ cidr: '2001:db8:42::/64', vrfId: vrf.id }).expect(201);
      expect(s.body.totalHosts).toBe('18446744073709551616');
      const first = await api().post(`/api/v1/subnets/${s.body.id}/allocate`).set(as('admin')).send({}).expect(201);
      expect(first.body.ip).toBe('2001:db8:42::');
    });
  });
});
