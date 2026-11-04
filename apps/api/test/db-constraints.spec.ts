import { PrismaClient } from '@prisma/client';
import { sqlStateOf } from '../src/common/db-errors';
import { makeRack, makeVrf } from './fixtures';

/** These rules hold even for raw SQL that bypasses the API. */
describe('database integrity', () => {
  const prisma = new PrismaClient();
  afterAll(() => prisma.$disconnect());

  const place = (rackId: string, name: string, startU: number | null, sizeU: number, face: 'front' | 'rear' | null, depth: 'full' | 'half' | 'zero_u') =>
    prisma.$executeRaw`INSERT INTO assets (name, type, rack_id, start_u, size_u, face, depth)
      VALUES (${name}, 'physical_server', ${rackId}::uuid, ${startU}::smallint, ${sizeU}::smallint, ${face}::rack_face, ${depth}::mount_depth)`;

  const stateOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      return sqlStateOf(e) ?? String(e);
    }
  };

  describe('rack U-space', () => {
    it('rejects overlapping devices on the same face (23P01)', async () => {
      const rack = await makeRack(prisma);
      await place(rack.id, 'a', 10, 2, 'front', 'full');
      expect(await stateOf(place(rack.id, 'b', 11, 1, 'front', 'full'))).toBe('23P01');
    });

    it('a full-depth device blocks the rear face too', async () => {
      const rack = await makeRack(prisma);
      await place(rack.id, 'a', 20, 2, 'front', 'full');
      expect(await stateOf(place(rack.id, 'b', 21, 1, 'rear', 'half'))).toBe('23P01');
    });

    it('half-depth devices can share a U on opposite faces', async () => {
      const rack = await makeRack(prisma);
      await place(rack.id, 'front-panel', 5, 1, 'front', 'half');
      expect(await stateOf(place(rack.id, 'rear-panel', 5, 1, 'rear', 'half'))).toBe('OK');
    });

    it('zero-U PDUs take no U space', async () => {
      const rack = await makeRack(prisma);
      await place(rack.id, 'srv', 1, 42, 'front', 'full');
      expect(await stateOf(place(rack.id, 'pdu', null, 1, null, 'zero_u'))).toBe('OK');
    });

    it('rejects a device that runs past the top of the rack (KB001)', async () => {
      const rack = await makeRack(prisma, 42);
      expect(await stateOf(place(rack.id, 'tall', 41, 4, 'front', 'full'))).toBe('KB001');
      expect(await stateOf(place(rack.id, 'fits', 39, 4, 'front', 'full'))).toBe('OK');
    });

    it('enforces all-or-nothing placement fields', async () => {
      const rack = await makeRack(prisma);
      expect(await stateOf(place(rack.id, 'no-face', 3, 1, null, 'full'))).toBe('23514');
    });

    it('moving a device updates its occupancy', async () => {
      const rack = await makeRack(prisma);
      await place(rack.id, 'mover', 1, 1, 'front', 'full');
      await prisma.$executeRaw`UPDATE assets SET start_u = 30 WHERE name = 'mover' AND rack_id = ${rack.id}::uuid`;
      expect(await stateOf(place(rack.id, 'takes-old-slot', 1, 1, 'front', 'full'))).toBe('OK');
      expect(await stateOf(place(rack.id, 'clashes-new-slot', 30, 1, 'front', 'full'))).toBe('23P01');
    });

    it('a rack cannot shrink below mounted devices', async () => {
      const rack = await makeRack(prisma, 42);
      await place(rack.id, 'high', 40, 2, 'front', 'full');
      expect(await stateOf(prisma.$executeRaw`UPDATE racks SET height_u = 24 WHERE id = ${rack.id}::uuid`)).toBe('KB001');
    });
  });

  describe('IPAM', () => {
    const subnet = (cidr: string, vrfId: string) =>
      prisma.$queryRaw<Array<{ id: string; parent_id: string | null }>>`INSERT INTO subnets (cidr, vrf_id) VALUES (${cidr}::cidr, ${vrfId}::uuid) RETURNING id, parent_id`;

    it('nests subnets under their smallest parent and adopts children', async () => {
      const vrf = await makeVrf(prisma);
      const [s16] = await subnet('10.1.0.0/16', vrf.id);
      const [s24] = await subnet('10.1.1.0/24', vrf.id);
      expect(s24.parent_id).toBe(s16.id);
      const [s20] = await subnet('10.1.0.0/20', vrf.id);
      expect(s20.parent_id).toBe(s16.id);
      const [moved] = await prisma.$queryRaw<Array<{ parent_id: string }>>`SELECT parent_id FROM subnets WHERE id = ${s24.id}::uuid`;
      expect(moved.parent_id).toBe(s20.id);
    });

    it('rejects a duplicate subnet in the same VRF but allows it in another', async () => {
      const a = await makeVrf(prisma);
      const b = await makeVrf(prisma);
      await subnet('192.168.10.0/24', a.id);
      expect(await stateOf(subnet('192.168.10.0/24', a.id))).toBe('23505');
      expect(await stateOf(subnet('192.168.10.0/24', b.id))).toBe('OK');
    });

    it('rejects host bits via parse_cidr_strict (KB003)', async () => {
      expect(await stateOf(prisma.$queryRaw`SELECT parse_cidr_strict('10.0.0.5/24')`)).toBe('KB003');
    });

    it('keeps IPs inside their subnet and off network/broadcast', async () => {
      const vrf = await makeVrf(prisma);
      const [s] = await subnet('172.16.5.0/24', vrf.id);
      const ip = (addr: string) => prisma.$executeRaw`INSERT INTO ip_addresses (ip, subnet_id) VALUES (${addr}::inet, ${s.id}::uuid)`;
      expect(await stateOf(ip('172.16.6.1'))).toBe('KB004');
      expect(await stateOf(ip('172.16.5.0'))).toBe('KB005');
      expect(await stateOf(ip('172.16.5.255'))).toBe('KB005');
      expect(await stateOf(ip('172.16.5.10/24'))).toBe('OK');
      expect(await stateOf(ip('172.16.5.10'))).toBe('23505');
    });
  });

  describe('audit trail', () => {
    it('is append-only (KB006)', async () => {
      await prisma.$executeRaw`INSERT INTO audit_logs (entity, entity_id, action, after) VALUES ('asset', gen_random_uuid(), 'create', '{}')`;
      expect(await stateOf(prisma.$executeRaw`UPDATE audit_logs SET entity = 'x'`)).toBe('KB006');
      expect(await stateOf(prisma.$executeRaw`DELETE FROM audit_logs`)).toBe('KB006');
    });
  });

  describe('CMDB graph', () => {
    it('ci_impacted_by walks dependents transitively without looping', async () => {
      const mk = (name: string) => prisma.assets.create({ data: { name, type: 'other' } });
      const [storage, db, app, web] = await Promise.all(['lun', 'db', 'app', 'web'].map(mk));
      const dep = (s: string, t: string) => prisma.ci_relationships.create({ data: { source_asset_id: s, target_asset_id: t, relationship_type: 'depends_on' } });
      await dep(db.id, storage.id);
      await dep(app.id, db.id);
      await dep(web.id, app.id);
      await dep(db.id, web.id); // cycle
      const rows = await prisma.$queryRaw<Array<{ asset_id: string; depth: number }>>`SELECT asset_id, depth FROM ci_impacted_by(${storage.id}::uuid)`;
      const depth = Object.fromEntries(rows.map((r) => [r.asset_id, r.depth]));
      expect(depth).toEqual({ [db.id]: 1, [app.id]: 2, [web.id]: 3 });
    });
  });
});
