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
      // Machine account for apps/discovery-worker: pnpm --filter @itam/api token --role discovery_service
      ['discovery-worker@example.com', 'Discovery worker', 'discovery_service'],
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
        { name: 'pdu-a01-r', type: 'pdu', model: pduModel, start_u: null, face: null, power: 0, temp: null },
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

    if ((await tx.vendors.count()) === 0) await seedLifecycle(tx, rack.id);
  }, { timeout: 60_000 });
  console.log('seed: done');
}

type SeedTx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000);

/** Phase 2 demo data: contracts in every state, hardware, cabling through the patch panel, A/B power. */
async function seedLifecycle(tx: SeedTx, rackId: string) {
  const byName = new Map((await tx.assets.findMany({ where: { rack_id: rackId } })).map((a) => [a.name, a]));
  const id = (name: string) => byName.get(name)!.id;

  const dell = await tx.vendors.create({ data: { name: 'Dell Technologies', support_phone: '+1-800-624-9897', website: 'https://www.dell.com' } });
  const arista = await tx.vendors.create({ data: { name: 'Arista Networks', support_email: 'support@arista.com' } });
  const netapp = await tx.vendors.create({ data: { name: 'NetApp' } });

  const contract = (vendor_id: string, contract_type: 'warranty' | 'support', contract_number: string, start: number, end: number, names: string[], cost?: number) =>
    tx.contracts.create({
      data: {
        vendor_id, contract_type, contract_number, start_date: day(start), end_date: day(end), cost, notice_days: 60,
        contract_assets: { create: names.map((n) => ({ asset_id: id(n) })) },
      },
    });
  await contract(dell.id, 'warranty', 'DELL-PS-7781', -700, 395, ['esx-01', 'esx-02'], 4800);
  await contract(dell.id, 'support', 'DELL-PS-7790', -1000, 21, ['db-01'], 2100);
  await contract(arista.id, 'support', 'ARI-A-2231', -360, 75, ['core-sw-01', 'core-sw-02'], 6200);
  await contract(netapp.id, 'warranty', 'NTAP-99812', -1460, -12, ['nas-01']);
  // esx-03 deliberately has no contract: it shows up under coverage gaps.

  const po = await tx.purchase_orders.create({ data: { po_number: 'PO-2024-0142', vendor_id: dell.id, order_date: day(-720), total_amount: 38400 } });
  for (const n of ['esx-01', 'esx-02', 'esx-03', 'db-01']) {
    await tx.asset_financials.create({
      data: { asset_id: id(n), purchase_order_id: po.id, purchase_date: day(-720), in_service_date: day(-700), purchase_cost: 9600, useful_life_months: 60, salvage_value: 600 },
    });
  }

  for (const n of ['esx-01', 'esx-02', 'esx-03', 'db-01']) {
    await tx.asset_components.createMany({
      data: [
        { asset_id: id(n), kind: 'cpu', slot: 'CPU1', manufacturer: 'Intel', model: 'Xeon Gold 6430', capacity: 32 },
        { asset_id: id(n), kind: 'cpu', slot: 'CPU2', manufacturer: 'Intel', model: 'Xeon Gold 6430', capacity: 32 },
        ...Array.from({ length: 8 }, (_, i) => ({ asset_id: id(n), kind: 'memory' as const, slot: `DIMM A${i + 1}`, manufacturer: 'Samsung', model: 'M321R8GA0BB0', capacity: 64 })),
        { asset_id: id(n), kind: 'disk', slot: 'Bay 0', manufacturer: 'Dell', model: 'PM1733a NVMe', capacity: 3840 },
        { asset_id: id(n), kind: 'disk', slot: 'Bay 1', manufacturer: 'Dell', model: 'PM1733a NVMe', capacity: 3840 },
      ],
    });
  }

  await tx.maintenance_schedules.create({ data: { asset_id: id('nas-01'), title: 'Controller firmware review', interval_days: 90, first_due_on: day(-3) } });
  await tx.maintenance_schedules.create({ data: { asset_id: id('pdu-a01-l'), title: 'Thermal scan of outlets', interval_days: 180, first_due_on: day(10) } });

  // Network: servers → front patch panel → (pass-through) → rear → core switch.
  const port = async (asset: string, name: string, kind: string, extra = '') =>
    (await tx.$queryRawUnsafe<Array<{ id: string }>>(`INSERT INTO network_ports (asset_id, port_name, kind${extra ? ', pass_through_port_id' : ''}) VALUES ($1::uuid, $2, $3::port_kind${extra ? ', $4::uuid' : ''}) RETURNING id`, ...[id(asset), name, kind, ...(extra ? [extra] : [])]))[0].id;
  const cable = (a: string, b: string, label: string) => tx.$executeRaw`INSERT INTO cables (a_port_id, b_port_id, media, label) VALUES (${a}::uuid, ${b}::uuid, 'cat6', ${label})`;
  const servers = ['esx-01', 'esx-02', 'esx-03', 'db-01'];
  for (const [i, n] of servers.entries()) {
    const nic = await port(n, 'eth1', 'ethernet');
    await port(n, 'eth2', 'ethernet');
    const rear = await port('patch-a01-f', `P${i + 1}-R`, 'patch_rear');
    const front = await port('patch-a01-f', `P${i + 1}`, 'patch_front', rear);
    const sw = await port('core-sw-01', `Ethernet${i + 1}`, 'ethernet');
    await cable(nic, front, `A01-${String(i + 1).padStart(3, '0')}`);
    await cable(rear, sw, `A01-${String(i + 101).padStart(3, '0')}`);
  }

  // Power: two vertical PDUs on feeds A and B; servers dual-corded, switches dual-corded, esx-03 left on one cord.
  for (const [pdu, feed] of [['pdu-a01-l', 'A'], ['pdu-a01-r', 'B']] as const) {
    await tx.power_ports.create({ data: { asset_id: id(pdu), name: 'Inlet', kind: 'inlet', voltage: 230, max_amps: 32 } });
    await tx.power_ports.createMany({ data: Array.from({ length: 24 }, (_, i) => ({ asset_id: id(pdu), name: `${feed}${i + 1}`, kind: 'outlet' as const, feed, voltage: 230 })) });
  }
  const outlets = await tx.power_ports.findMany({ where: { kind: 'outlet', asset_id: { in: [id('pdu-a01-l'), id('pdu-a01-r')] } } });
  const outlet = (name: string) => outlets.find((o) => o.name === name)!.id;
  let slot = 1;
  for (const n of ['core-sw-01', 'core-sw-02', 'esx-01', 'esx-02', 'esx-03', 'db-01', 'nas-01']) {
    const [psu1, psu2] = await Promise.all(
      ['PSU1', 'PSU2'].map((name) => tx.power_ports.create({ data: { asset_id: id(n), name, kind: 'inlet', voltage: 230 } })),
    );
    await tx.power_connections.create({ data: { outlet_port_id: outlet(`A${slot}`), inlet_port_id: psu1.id } });
    if (n !== 'esx-03') await tx.power_connections.create({ data: { outlet_port_id: outlet(`B${slot}`), inlet_port_id: psu2.id } });
    slot++;
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
