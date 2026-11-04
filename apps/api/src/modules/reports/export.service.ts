import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../common/prisma.service';
import { csvLine } from './csv';
import { ASSET_COLUMNS } from './import.service';

const PAGE = 1000;

/**
 * Streaming CSV exports with keyset pagination: memory stays flat for any table size, and the
 * client starts receiving data at once. The asset export uses the import columns, so a file can be
 * exported, edited in a spreadsheet and imported back.
 */
@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly datasets: Record<string, { header: readonly string[]; page: (after: string) => Promise<Array<{ key: string; values: unknown[] }>> }> = {
    assets: {
      header: [...ASSET_COLUMNS, 'id', 'last_discovered_at', 'updated_at'],
      page: async (after) => {
        const rows = await this.prisma.$queryRaw<Array<Record<string, unknown> & { id: string }>>`
          SELECT a.id, a.name, a.type, a.status, a.asset_tag, a.serial_number, s.name AS site, r.name AS rack, a.start_u, a.size_u, a.face, a.depth,
                 a.power_draw_w, a.last_discovered_at, a.updated_at
          FROM assets a LEFT JOIN racks r ON r.id = a.rack_id LEFT JOIN rooms rm ON rm.id = r.room_id LEFT JOIN buildings b ON b.id = rm.building_id LEFT JOIN sites s ON s.id = b.site_id
          WHERE a.id > ${after}::uuid ORDER BY a.id LIMIT ${PAGE}`;
        return rows.map((r) => ({ key: r.id, values: [r.name, r.type, r.status, r.asset_tag, r.serial_number, r.site, r.rack, r.start_u, r.size_u, r.face, r.depth, r.power_draw_w, r.id, r.last_discovered_at, r.updated_at] }));
      },
    },
    'ip-addresses': {
      header: ['ip', 'status', 'subnet', 'vrf', 'asset', 'dns_name', 'last_seen_at', 'id'],
      page: async (after) => {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; ip: string; status: string; subnet: string; vrf: string | null; asset: string | null; dns_name: string | null; last_seen_at: Date | null }>>`
          SELECT i.id, host(i.ip) AS ip, i.status, s.cidr::text AS subnet, v.name AS vrf, a.name AS asset, i.dns_name, i.last_seen_at
          FROM ip_addresses i JOIN subnets s ON s.id = i.subnet_id LEFT JOIN vrfs v ON v.id = i.vrf_id LEFT JOIN assets a ON a.id = i.asset_id
          WHERE i.id > ${after}::uuid ORDER BY i.id LIMIT ${PAGE}`;
        return rows.map((r) => ({ key: r.id, values: [r.ip, r.status, r.subnet, r.vrf, r.asset, r.dns_name, r.last_seen_at, r.id] }));
      },
    },
    subnets: {
      header: ['cidr', 'name', 'vrf', 'vlan', 'parent', 'assigned', 'id'],
      page: async (after) => {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; cidr: string; name: string | null; vrf: string | null; vlan: number | null; parent: string | null; assigned: bigint }>>`
          SELECT s.id, s.cidr::text AS cidr, s.name, v.name AS vrf, vl.vid AS vlan, p.cidr::text AS parent,
                 (SELECT count(*) FROM ip_addresses i WHERE i.subnet_id = s.id) AS assigned
          FROM subnets s LEFT JOIN vrfs v ON v.id = s.vrf_id LEFT JOIN vlans vl ON vl.id = s.vlan_id LEFT JOIN subnets p ON p.id = s.parent_id
          WHERE s.id > ${after}::uuid ORDER BY s.id LIMIT ${PAGE}`;
        return rows.map((r) => ({ key: r.id, values: [r.cidr, r.name, r.vrf, r.vlan, r.parent, Number(r.assigned), r.id] }));
      },
    },
    contracts: {
      header: ['contract_number', 'type', 'vendor', 'start_date', 'end_date', 'cost', 'currency', 'auto_renew', 'notice_days', 'assets', 'id'],
      page: async (after) => {
        const rows = await this.prisma.$queryRaw<Array<{ id: string; contract_number: string; contract_type: string; vendor: string; start_date: Date; end_date: Date; cost: string | null; currency: string; auto_renew: boolean; notice_days: number; assets: string[] | null }>>`
          SELECT c.id, c.contract_number, c.contract_type, v.name AS vendor, c.start_date, c.end_date, c.cost::text, c.currency, c.auto_renew, c.notice_days,
                 (SELECT array_agg(a.name ORDER BY a.name) FROM contract_assets ca JOIN assets a ON a.id = ca.asset_id WHERE ca.contract_id = c.id) AS assets
          FROM contracts c JOIN vendors v ON v.id = c.vendor_id WHERE c.id > ${after}::uuid ORDER BY c.id LIMIT ${PAGE}`;
        return rows.map((r) => ({ key: r.id, values: [r.contract_number, r.contract_type, r.vendor, r.start_date.toISOString().slice(0, 10), r.end_date.toISOString().slice(0, 10), r.cost, r.currency, r.auto_renew, r.notice_days, r.assets ?? [], r.id] }));
      },
    },
  };

  has(name: string) {
    return name in this.datasets;
  }

  async stream(name: string, res: Response) {
    const ds = this.datasets[name];
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="itam-${name}-${stamp}.csv"`);
    res.setHeader('cache-control', 'no-store');
    res.write('﻿'); // Excel needs the BOM to read UTF-8
    res.write(csvLine([...ds.header]));
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows = await ds.page(after);
      if (!rows.length) break;
      // Respect back-pressure from slow clients.
      if (!res.write(rows.map((r) => csvLine(r.values)).join(''))) await new Promise((r) => res.once('drain', r));
      after = rows[rows.length - 1].key;
      if (rows.length < PAGE) break;
    }
    res.end();
  }
}
