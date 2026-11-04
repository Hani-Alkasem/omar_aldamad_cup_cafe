// Demo data: one site with a 42U rack of typical gear, users for each role, and an IP plan.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  await prisma.$transaction(async (tx) => {
    const users = [
      ['admin@example.com', 'Ada Admin', 'admin'],
      ['tech@example.com', 'Dana Technician', 'dc_technician'],
      ['neteng@example.com', 'Nour Network', 'network_engineer'],
      ['audit@example.com', 'Ari Auditor', 'auditor'],
    ] as const;
    for (const [email, display_name, role] of users) {
      if (!(await tx.users.findFirst({ where: { email } }))) await tx.users.create({ data: { email, display_name, role } });
    }

    const site = await tx.sites.upsert({ where: { name: 'DC-East' }, update: {}, create: { name: 'DC-East', address: '1 Example Way' } });
    const building = (await tx.buildings.findFirst({ where: { site_id: site.id, name: 'Building A' } })) ?? (await tx.buildings.create({ data: { site_id: site.id, name: 'Building A' } }));
    const room = (await tx.rooms.findFirst({ where: { building_id: building.id, name: 'Hall 1' } })) ?? (await tx.rooms.create({ data: { building_id: building.id, name: 'Hall 1', floor: '1' } }));
    const row = (await tx.rack_rows.findFirst({ where: { room_id: room.id, name: 'Row A' } })) ?? (await tx.rack_rows.create({ data: { room_id: room.id, name: 'Row A' } }));
    const rack = (await tx.racks.findFirst({ where: { room_id: room.id, name: 'A01' } })) ?? (await tx.racks.create({ data: { room_id: room.id, row_id: row.id, name: 'A01', height_u: 42, max_power_w: 8000 } }));

    if ((await tx.assets.count({ where: { rack_id: rack.id } })) === 0) {
      const mfr = async (name: string) => (await tx.manufacturers.findFirst({ where: { name } })) ?? tx.manufacturers.create({ data: { name } });
      const model = async (m: string, model_number: string, size_u: number, depth: 'full' | 'half' | 'zero_u', ports: number, watts: number) =>
        tx.hardware_models.create({ data: { manufacturer_id: (await mfr(m)).id, model_number, size_u, depth, network_ports_count: ports, typical_power_w: watts } });

      const switchModel = await model('Arista', '7050SX3-48YC8', 1, 'full', 56, 350);
      const serverModel = await model('Dell', 'PowerEdge R760', 2, 'full', 4, 750);
      const storageModel = await model('NetApp', 'AFF A250', 2, 'full', 8, 900);
      const patchModel = await model('Panduit', 'CP48BLY', 1, 'half', 48, 0);
      const pduModel = await model('APC', 'AP8881', 0, 'zero_u', 0, 0);

      const devices = [
        { name: 'core-sw-01', type: 'switch', model: switchModel, start_u: 42, face: 'front', power: 340, temp: 27 },
        { name: 'core-sw-02', type: 'switch', model: switchModel, start_u: 41, face: 'front', power: 330, temp: 27 },
        { name: 'patch-a01-f', type: 'patch_panel', model: patchModel, start_u: 40, face: 'front', power: 0, temp: null },
        { name: 'patch-a01-r', type: 'patch_panel', model: patchModel, start_u: 40, face: 'rear', power: 0, temp: null },
        { name: 'esx-01', type: 'physical_server', model: serverModel, start_u: 30, face: 'front', power: 610, temp: 24 },
        { name: 'esx-02', type: 'physical_server', model: serverModel, start_u: 28, face: 'front', power: 640, temp: 25 },
        { name: 'esx-03', type: 'physical_server', model: serverModel, start_u: 26, face: 'front', power: 0, temp: null, status: 'maintenance' },
        { name: 'db-01', type: 'physical_server', model: serverModel, start_u: 22, face: 'front', power: 720, temp: 26 },
        { name: 'nas-01', type: 'storage_array', model: storageModel, start_u: 10, face: 'front', power: 880, temp: 29 },
        { name: 'pdu-a01-l', type: 'pdu', model: pduModel, start_u: null, face: null, power: 0, temp: null },
      ] as const;

      let n = 1;
      for (const d of devices) {
        await tx.assets.create({
          data: {
            name: d.name,
            type: d.type,
            status: ('status' in d ? d.status : 'active') as never,
            asset_tag: `AT-${String(n).padStart(5, '0')}`,
            serial_number: `SN${String(100000 + n++)}`,
            model_id: d.model.id,
            rack_id: rack.id,
            start_u: d.start_u,
            size_u: Math.max(1, d.model.size_u),
            face: d.face,
            depth: d.model.depth,
            power_draw_w: d.power || null,
            custom_fields: d.temp ? { inletTempC: d.temp } : {},
          },
        });
      }
    }

    const existing = await tx.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM subnets`;
    if (Number(existing[0].n) === 0) {
      for (const [cidr, name] of [
        ['10.20.0.0/16', 'DC-East aggregate'],
        ['10.20.10.0/24', 'Servers'],
        ['10.20.20.0/24', 'Storage'],
        ['10.20.99.0/26', 'Management'],
        ['2001:db8:20::/48', 'DC-East IPv6'],
      ]) {
        await tx.$executeRaw`INSERT INTO subnets (cidr, name) VALUES (${cidr}::cidr, ${name})`;
      }
    }
  });
  console.log('seed: done');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
