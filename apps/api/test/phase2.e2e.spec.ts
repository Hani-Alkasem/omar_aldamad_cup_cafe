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
import { makeRack, makeUser } from './fixtures';

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe('Phase 2: lifecycle, components, cabling, power', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prisma = new PrismaClient();
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
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
  const uniq = () => randomUUID().slice(0, 8);
  const asset = async (type: string, extra: Record<string, unknown> = {}) =>
    (await api().post('/api/v1/assets').set(as('admin')).send({ name: `${type}-${uniq()}`, type, ...extra }).expect(201)).body as { id: string; name: string };

  describe('lifecycle and financials', () => {
    it('contracts: expiring window, notice flag, coverage gaps', async () => {
      const vendor = (await api().post('/api/v1/vendors').set(as('admin')).send({ name: `Vendor ${uniq()}` }).expect(201)).body;
      await api().post('/api/v1/vendors').set(as('admin')).send({ name: vendor.name.toUpperCase() }).expect(409);

      const covered = await asset('physical_server', { status: 'active' });
      const bare = await asset('physical_server', { status: 'active' });

      const c = await api()
        .post('/api/v1/contracts')
        .set(as('admin'))
        .send({ vendorId: vendor.id, contractType: 'warranty', contractNumber: `W-${uniq()}`, startDate: isoDay(-300), endDate: isoDay(20), noticeDays: 30, assetIds: [covered.id] })
        .expect(201);
      expect(c.body).toMatchObject({ status: 'active', daysLeft: 20, assets: [{ id: covered.id }] });

      const mine = (await api().get(`/api/v1/assets/${covered.id}/contracts`).set(as('auditor')).expect(200)).body;
      expect(mine.map((x: { id: string }) => x.id)).toEqual([c.body.id]);
      expect((await api().get(`/api/v1/assets/${bare.id}/contracts`).set(as('auditor')).expect(200)).body).toEqual([]);

      const expiring = await api().get('/api/v1/contracts/expiring?withinDays=30').set(as('auditor')).expect(200);
      const hit = expiring.body.find((x: { id: string }) => x.id === c.body.id);
      expect(hit).toMatchObject({ inNoticeWindow: true });

      const gaps = (await api().get('/api/v1/contracts/coverage-gaps').set(as('auditor')).expect(200)).body as Array<{ id: string }>;
      expect(gaps.some((g) => g.id === bare.id)).toBe(true);
      expect(gaps.some((g) => g.id === covered.id)).toBe(false);

      await api()
        .post('/api/v1/contracts')
        .set(as('admin'))
        .send({ vendorId: vendor.id, contractType: 'support', contractNumber: 'X', startDate: isoDay(0), endDate: isoDay(-1) })
        .expect(400);
      await api().post('/api/v1/vendors').set(as('dc_technician')).send({ name: 'nope' }).expect(403);
    });

    it('financials compute book value and reject salvage above cost', async () => {
      const a = await asset('physical_server');
      const res = await api()
        .put(`/api/v1/assets/${a.id}/financials`)
        .set(as('admin'))
        .send({ purchaseCost: 12000, salvageValue: 0, usefulLifeMonths: 60, inServiceDate: isoDay(-366), depreciationMethod: 'straight_line' })
        .expect(200);
      expect(res.body.depreciation.ageMonths).toBe(12);
      expect(res.body.depreciation.bookValue).toBeCloseTo(9600, 0);

      await api().put(`/api/v1/assets/${a.id}/financials`).set(as('admin')).send({ purchaseCost: 100, salvageValue: 200, usefulLifeMonths: 12 }).expect(400);
    });

    it('maintenance: completing moves the next due date forward by the interval', async () => {
      const a = await asset('ups');
      const m = await api()
        .post(`/api/v1/assets/${a.id}/maintenance`)
        .set(as('dc_technician'))
        .send({ title: 'Battery test', intervalDays: 90, firstDueOn: isoDay(-1) })
        .expect(201);
      expect(m.body.nextDueOn).toBe(isoDay(-1));
      const due = (await api().get('/api/v1/maintenance/due?withinDays=0').set(as('auditor')).expect(200)).body as Array<{ id: string }>;
      expect(due.some((d) => d.id === m.body.id)).toBe(true);

      const done = await api().post(`/api/v1/maintenance/${m.body.id}/complete`).set(as('dc_technician')).send({ doneOn: isoDay(0) }).expect(201);
      expect(done.body.nextDueOn).toBe(isoDay(90));
    });
  });

  describe('components', () => {
    it('summarises CPU, memory and disk', async () => {
      const a = await asset('physical_server');
      for (const body of [
        { kind: 'cpu', model: 'EPYC 9354', capacity: 32 },
        { kind: 'cpu', model: 'EPYC 9354', capacity: 32 },
        { kind: 'memory', capacity: 64 },
        { kind: 'memory', capacity: 64 },
        { kind: 'disk', capacity: 3840 },
      ]) {
        await api().post(`/api/v1/assets/${a.id}/components`).set(as('dc_technician')).send(body).expect(201);
      }
      const res = await api().get(`/api/v1/assets/${a.id}/components`).set(as('auditor')).expect(200);
      expect(res.body.items).toHaveLength(5);
      expect(res.body.summary).toMatchObject({ cpuCores: 64, memoryGb: 128, diskGb: 3840 });
    });
  });

  describe('cabling', () => {
    it('traces server → patch panel pass-through → switch and blocks double-cabling', async () => {
      const srv = await asset('physical_server');
      const pp = await asset('patch_panel');
      const sw = await asset('switch');
      const [srvPorts, ppPorts, swPorts] = await Promise.all([
        api().post(`/api/v1/assets/${srv.id}/ports/bulk`).set(as('dc_technician')).send({ prefix: 'eth', count: 2 }).expect(201),
        api().post(`/api/v1/assets/${pp.id}/ports/bulk`).set(as('dc_technician')).send({ prefix: 'P', count: 4, patchPanel: true }).expect(201),
        api().post(`/api/v1/assets/${sw.id}/ports/bulk`).set(as('dc_technician')).send({ prefix: 'Gi1/0/', count: 4 }).expect(201),
      ]);
      expect(ppPorts.body).toHaveLength(8);
      const port = (list: Array<{ id: string; portName: string }>, name: string) => list.find((p) => p.portName === name)!.id;

      await api().post('/api/v1/cables').set(as('network_engineer')).send({ aPortId: port(srvPorts.body, 'eth1'), bPortId: port(ppPorts.body, 'P1') }).expect(201);
      await api().post('/api/v1/cables').set(as('network_engineer')).send({ aPortId: port(ppPorts.body, 'P1-R'), bPortId: port(swPorts.body, 'Gi1/0/1') }).expect(201);

      const dup = await api().post('/api/v1/cables').set(as('network_engineer')).send({ aPortId: port(srvPorts.body, 'eth1'), bPortId: port(swPorts.body, 'Gi1/0/2') }).expect(409);
      expect(dup.body.code).toBe('PORT_IN_USE');

      const trace = await api().get(`/api/v1/ports/${port(srvPorts.body, 'eth1')}/trace`).set(as('auditor')).expect(200);
      expect(trace.body.endReason).toBe('endpoint');
      expect(trace.body.hops.at(-1)).toMatchObject({ assetId: sw.id, portName: 'Gi1/0/1' });

      const del = await api().delete(`/api/v1/ports/${port(srvPorts.body, 'eth1')}`).set(as('dc_technician')).expect(409);
      expect(del.body.code).toBe('PORT_CABLED');

      await api().post(`/api/v1/assets/${srv.id}/ports/bulk`).set(as('dc_technician')).send({ prefix: 'X', count: 1, patchPanel: true }).expect(422);
    });

    it('DB rejects a pass-through across two assets (KB011)', async () => {
      const a = await asset('patch_panel');
      const b = await asset('patch_panel');
      const [front] = await prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO network_ports (asset_id, port_name, kind) VALUES (${a.id}::uuid, 'F', 'patch_front') RETURNING id`;
      const [rear] = await prisma.$queryRaw<Array<{ id: string }>>`INSERT INTO network_ports (asset_id, port_name, kind) VALUES (${b.id}::uuid, 'R', 'patch_rear') RETURNING id`;
      const err = await prisma.$executeRaw`UPDATE network_ports SET pass_through_port_id = ${rear.id}::uuid WHERE id = ${front.id}::uuid`.catch((e) => e);
      expect(sqlStateOf(err)).toBe('KB011');
    });
  });

  describe('power', () => {
    it('A/B-fed rack budget, single-fed detection, powered_by CMDB edge', async () => {
      const rack = await makeRack(prisma);
      await prisma.racks.update({ where: { id: rack.id }, data: { max_power_w: 5000 } });
      const pduA = await asset('pdu', { rackId: rack.id, depth: 'zero_u' });
      const pduB = await asset('pdu', { rackId: rack.id, depth: 'zero_u' });
      const srv = await asset('physical_server', { rackId: rack.id, startU: 10, sizeU: 2, face: 'front', depth: 'full', powerDrawW: 600 });
      const sw = await asset('switch', { rackId: rack.id, startU: 40, sizeU: 1, face: 'front', depth: 'full', powerDrawW: 150 });

      const bulk = (id: string, body: object) => api().post(`/api/v1/assets/${id}/power-ports/bulk`).set(as('dc_technician')).send(body).expect(201);
      const [aOut, bOut, srvIn, swIn] = await Promise.all([
        bulk(pduA.id, { kind: 'outlet', prefix: 'A', count: 8, feed: 'A' }).then((r) => r.body),
        bulk(pduB.id, { kind: 'outlet', prefix: 'B', count: 8, feed: 'B' }).then((r) => r.body),
        bulk(srv.id, { kind: 'inlet', prefix: 'PSU', count: 2 }).then((r) => r.body),
        bulk(sw.id, { kind: 'inlet', prefix: 'PSU', count: 1 }).then((r) => r.body),
      ]);

      const plug = (outletPortId: string, inletPortId: string) => api().post('/api/v1/power-connections').set(as('dc_technician')).send({ outletPortId, inletPortId });
      await plug(aOut[0].id, srvIn[0].id).expect(201);
      const bCord = (await plug(bOut[0].id, srvIn[1].id).expect(201)).body;
      await plug(aOut[1].id, swIn[0].id).expect(201);

      expect((await plug(aOut[0].id, swIn[0].id).expect(409)).body.code).toBe('POWER_PORT_IN_USE');
      expect((await plug(srvIn[0].id, aOut[2].id).expect(422)).body.code).toBe('POWER_CONNECTION_INVALID');
      await api().post(`/api/v1/assets/${srv.id}/power-ports/bulk`).set(as('dc_technician')).send({ kind: 'outlet', prefix: 'O', count: 1 }).expect(422);

      const budget = (await api().get(`/api/v1/racks/${rack.id}/power`).set(as('auditor')).expect(200)).body;
      expect(budget.totalLoadW).toBe(750);
      expect(budget.headroomW).toBe(4250);
      const load = (pduId: string) => budget.pdus.find((p: { pduId: string }) => p.pduId === pduId).loadW;
      expect(load(pduA.id)).toBe(450); // 300 (half of server) + 150 (switch)
      expect(load(pduB.id)).toBe(300);
      // Single-PSU switch is not "single-fed": only devices with redundant supplies on one feed are flagged.
      expect(budget.singleFed).toEqual([]);
      expect(budget.unpowered).toEqual([]);

      const edges = await prisma.ci_relationships.findMany({ where: { source_asset_id: srv.id, relationship_type: 'powered_by' } });
      expect(edges.map((e) => e.target_asset_id).sort()).toEqual([pduA.id, pduB.id].sort());

      // Pull the B cord: server loses redundancy, its whole draw moves to PDU A, and the CMDB edge goes.
      await api().delete(`/api/v1/power-connections/${bCord.id}`).set(as('dc_technician')).expect(204);
      const after = (await api().get(`/api/v1/racks/${rack.id}/power`).set(as('auditor')).expect(200)).body;
      expect(after.singleFed).toEqual([{ id: srv.id, name: srv.name, feeds: ['A'] }]);
      expect(after.pdus.find((p: { pduId: string }) => p.pduId === pduA.id).loadW).toBe(750);
      expect(await prisma.ci_relationships.count({ where: { source_asset_id: srv.id, target_asset_id: pduB.id, relationship_type: 'powered_by' } })).toBe(0);
    });
  });

  describe('power graph trigger', () => {
    it('keeps powered_by when a cord moves to another outlet on the same PDU, drops it when moved away', async () => {
      const pdu = await asset('pdu');
      const pdu2 = await asset('pdu');
      const srv = await asset('physical_server');
      const pp = async (asset_id: string, name: string, kind: 'inlet' | 'outlet') => (await prisma.power_ports.create({ data: { asset_id, name, kind } })).id;
      const [o1, o2, o3, inlet] = [await pp(pdu.id, 'O1', 'outlet'), await pp(pdu.id, 'O2', 'outlet'), await pp(pdu2.id, 'O1', 'outlet'), await pp(srv.id, 'PSU1', 'inlet')];
      const conn = await prisma.power_connections.create({ data: { outlet_port_id: o1, inlet_port_id: inlet } });
      const edge = (target: string) => prisma.ci_relationships.count({ where: { source_asset_id: srv.id, target_asset_id: target, relationship_type: 'powered_by' } });

      await prisma.power_connections.update({ where: { id: conn.id }, data: { outlet_port_id: o2 } });
      expect(await edge(pdu.id)).toBe(1);

      await prisma.power_connections.update({ where: { id: conn.id }, data: { outlet_port_id: o3 } });
      expect([await edge(pdu.id), await edge(pdu2.id)]).toEqual([0, 1]);

      await prisma.power_connections.delete({ where: { id: conn.id } });
      expect(await edge(pdu2.id)).toBe(0);
    });
  });

  describe('QR lookup', () => {
    it('resolves by asset tag (case-insensitive) and serial', async () => {
      const tag = `AT-${uniq()}`;
      const serial = `SN${uniq()}`;
      const a = await asset('physical_server', { assetTag: tag, serialNumber: serial });
      expect((await api().get(`/api/v1/assets/lookup?tag=${tag.toLowerCase()}`).set(as('auditor')).expect(200)).body.id).toBe(a.id);
      expect((await api().get(`/api/v1/assets/lookup?tag=${serial}`).set(as('auditor')).expect(200)).body.id).toBe(a.id);
      await api().get('/api/v1/assets/lookup?tag=missing').set(as('auditor')).expect(404);
    });
  });
});
