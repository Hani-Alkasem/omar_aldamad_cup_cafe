import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { signToken } from '../src/modules/auth/auth.guard';
import { parseCsv } from '../src/modules/reports/csv';
import { makeUser } from './fixtures';

describe('Search, reports, CSV (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prisma = new PrismaClient();
  const tokens: Record<string, string> = {};
  const tag = randomUUID().slice(0, 6);
  const site = `Site-${tag}`;
  const rackName = `R-${tag}`;
  let rackId: string;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    for (const role of ['admin', 'dc_technician', 'auditor'] as const) tokens[role] = signToken((await makeUser(prisma, role)).id);
    const s = await prisma.sites.create({ data: { name: site } });
    const b = await prisma.buildings.create({ data: { site_id: s.id, name: 'B' } });
    const r = await prisma.rooms.create({ data: { building_id: b.id, name: 'R' } });
    rackId = (await prisma.racks.create({ data: { room_id: r.id, name: rackName, max_power_w: 4000 } })).id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const api = () => request(baseUrl);
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  const importCsv = (csv: string, dryRun: boolean, role = 'dc_technician') =>
    api().post(`/api/v1/imports/assets?dryRun=${dryRun}`).set(as(role)).set('content-type', 'text/csv').send(csv);

  const header = 'name,type,status,asset_tag,serial_number,site,rack,start_u,size_u,face,depth,power_draw_w';
  const good = [
    header,
    `esx-${tag}-01,physical_server,active,AT-${tag}-1,SN${tag}1,${site},${rackName},10,2,front,full,650`,
    `esx-${tag}-02,Physical Server,active,AT-${tag}-2,SN${tag}2,${site},${rackName},12,2,front,full,650`,
    `"sw-${tag}, core",switch,,AT-${tag}-3,,${site},${rackName},40,1,front,full,300`,
    `spare-${tag},physical_server,in_stock,,SN${tag}4,,,,,,,`,
  ].join('\n');

  describe('CSV import', () => {
    it('dry run reports the plan and writes nothing', async () => {
      const res = await importCsv(good, true).expect(201);
      expect(res.body).toMatchObject({ dryRun: true, rows: 4, create: 4, update: 0 });
      expect(await prisma.assets.count({ where: { name: { contains: tag } } })).toBe(0);
    });

    it('collects every problem, including two rows claiming the same U, and imports nothing', async () => {
      const bad = [
        header,
        `a-${tag},physical_server,active,,,${site},${rackName},20,2,front,full,`,
        `b-${tag},physical_server,active,,,${site},${rackName},21,1,front,full,`, // overlaps the row above
        `c-${tag},toaster,active,,,,,,,,,`,
        `d-${tag},switch,active,,,${site},no-such-rack,5,1,front,full,`,
        `e-${tag},switch,active,,,,,five,,,,`,
        `,switch,,,,,,,,,,`,
      ].join('\n');
      const res = await importCsv(bad, false).expect(422);
      expect(res.body.code).toBe('IMPORT_INVALID');
      const issues = res.body.details.issues as Array<{ row: number; column?: string; message: string }>;
      expect(issues.map((i) => i.row).sort()).toEqual([3, 4, 5, 6, 7]);
      expect(issues.find((i) => i.row === 3)?.message).toMatch(/U2[01]|occupied|conflict/i);
      expect(issues.find((i) => i.row === 4)).toMatchObject({ column: 'type' });
      expect(issues.find((i) => i.row === 5)).toMatchObject({ column: 'rack', message: expect.stringMatching(/no rack "no-such-rack"/) });
      expect(issues.find((i) => i.row === 6)).toMatchObject({ column: 'start_u' });
      expect(await prisma.assets.count({ where: { name: { contains: tag } } })).toBe(0);
    });

    it('commits, then a re-import matches by tag and serial', async () => {
      const res = await importCsv(good, false).expect(201);
      expect(res.body).toMatchObject({ dryRun: false, create: 4 });
      const a = await prisma.assets.findFirstOrThrow({ where: { asset_tag: `AT-${tag}-1` } });
      expect(a).toMatchObject({ rack_id: rackId, start_u: 10, power_draw_w: 650 });
      expect(await prisma.audit_logs.count({ where: { entity_id: a.id, action: 'create' } })).toBe(1);

      const again = await importCsv(good.replace(`SN${tag}4,,,,,,,`, `SN${tag}4,,,,,,,90`), false).expect(201);
      expect(again.body).toMatchObject({ create: 0, update: 1, unchanged: 3 });
      expect(again.body.plan.find((p: { row: number }) => p.row === 5)).toMatchObject({ action: 'update', matchedBy: 'serial_number' });
    });

    it('rejects duplicates within a file, bad headers, and readers', async () => {
      const dup = [header, `x-${tag},switch,,DUP-${tag},,,,,,,,`, `y-${tag},switch,,dup-${tag},,,,,,,,`].join('\n');
      expect((await importCsv(dup, true).expect(422)).body.details.issues[0]).toMatchObject({ row: 3, column: 'asset_tag', message: 'duplicates row 2' });
      expect((await importCsv('hostname,kind\nx,y', true).expect(422)).body.code).toBe('CSV_COLUMNS_MISSING');
      await importCsv(good, true, 'auditor').expect(403);
    });
  });

  describe('search', () => {
    it('finds by exact tag, fuzzy name, IP, CIDR and MAC', async () => {
      const a = await prisma.assets.findFirstOrThrow({ where: { asset_tag: `AT-${tag}-1` } });
      await prisma.$executeRaw`INSERT INTO network_ports (asset_id, port_name, mac_address) VALUES (${a.id}::uuid, 'eno1', '3c:ec:ef:aa:bb:01')`;
      await prisma.$executeRaw`INSERT INTO subnets (cidr, name) VALUES ('10.123.0.0/24'::cidr, ${`search-${tag}`})`;
      const [s] = await prisma.$queryRaw<Array<{ id: string }>>`SELECT id FROM subnets WHERE name = ${`search-${tag}`}`;
      await prisma.$executeRaw`INSERT INTO ip_addresses (ip, subnet_id, asset_id) VALUES ('10.123.0.7'::inet, ${s.id}::uuid, ${a.id}::uuid)`;

      const q = async (text: string) => (await api().get('/api/v1/search').query({ q: text }).set(as('auditor')).expect(200)).body;
      expect((await q(`at-${tag}-1`)).hits[0]).toMatchObject({ type: 'asset', id: a.id, matched: 'asset tag', score: 1 });
      expect((await q(`esx${tag}01`)).hits.some((h: { id: string }) => h.id === a.id)).toBe(true);
      expect(await q('10.123.0.7')).toMatchObject({ kind: 'ip', hits: [{ type: 'ip', title: '10.123.0.7', href: `/assets/${a.id}` }, { type: 'subnet', title: '10.123.0.0/24' }] });
      expect((await q('10.123.0.0/24')).hits.map((h: { type: string }) => h.type)).toContain('ip');
      expect((await q('3cec.efaa.bb01')).hits[0]).toMatchObject({ id: a.id, matched: 'MAC on eno1' });
      await api().get('/api/v1/search').set(as('auditor')).expect(400);
    });
  });

  describe('summary and export', () => {
    it('summarises capacity and power from the database', async () => {
      const s = (await api().get('/api/v1/reports/summary').set(as('auditor')).expect(200)).body;
      expect(s.assets.total).toBeGreaterThanOrEqual(4);
      expect(s.racks.hottest.find((r: { id: string }) => r.id === rackId)).toMatchObject({ loadW: 1600, maxPowerW: 4000, pct: 40 });
      expect(s).toHaveProperty('coverage.pct');
      expect(s).toHaveProperty('discovery.openConflicts');
    });

    it('streams a CSV that re-imports cleanly and is formula-safe', async () => {
      await prisma.assets.create({ data: { name: '=cmd|"/c calc"!A1', type: 'other' } });
      const res = await api().get('/api/v1/export/assets.csv').set(as('auditor')).buffer(true).parse((r, cb) => {
        let d = '';
        r.on('data', (c: Buffer) => (d += c));
        r.on('end', () => cb(null, d));
      }).expect(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(/attachment; filename="itam-assets-/);
      const csv = res.body as string;
      expect(csv).toContain(`"'=cmd|""/c calc""!A1"`);
      const parsed = parseCsv(csv);
      expect(parsed.header.slice(0, 12)).toEqual(header.split(','));
      // Round trip: the exported rows for this import re-import as unchanged.
      const mine = parsed.rows.filter((r) => r[0].includes(tag));
      const back = await importCsv([header, ...mine.map((r) => r.slice(0, 12).map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(','))].join('\n'), true).expect(201);
      expect(back.body).toMatchObject({ create: 0, update: 0, unchanged: 4 });
      await api().get('/api/v1/export/secrets.csv').set(as('auditor')).expect(404);
    });
  });
});
