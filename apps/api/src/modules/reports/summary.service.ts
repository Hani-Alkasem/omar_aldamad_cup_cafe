import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';

const n = (v: unknown) => Number(v ?? 0);

/** One round of aggregate queries for the dashboard. Every number is computed in the database. */
@Injectable()
export class SummaryService {
  constructor(private readonly prisma: PrismaService) {}

  async summary() {
    const db = this.prisma;
    const [byStatus, byType, racks, hottest, coverage, expiring, subnets, discovery, deliveries] = await Promise.all([
      db.$queryRaw<Array<{ status: string; count: bigint }>>`SELECT status, count(*) FROM assets GROUP BY status ORDER BY count(*) DESC`,
      db.$queryRaw<Array<{ type: string; count: bigint }>>`SELECT type, count(*) FROM assets GROUP BY type ORDER BY count(*) DESC LIMIT 8`,
      // U space: a full-depth device fills both faces, so count per face and halve.
      db.$queryRaw<Array<{ racks: bigint; total_u: bigint; used_face_u: bigint }>>`
        SELECT (SELECT count(*) FROM racks) AS racks,
               (SELECT coalesce(sum(height_u), 0) FROM racks) AS total_u,
               (SELECT coalesce(sum(upper(u_range) - lower(u_range)), 0) FROM asset_rack_occupancy) AS used_face_u`,
      db.$queryRaw<Array<{ id: string; name: string; load_w: bigint; max_power_w: number | null }>>`
        SELECT r.id, r.name, coalesce(sum(a.power_draw_w), 0) AS load_w, r.max_power_w
        FROM racks r LEFT JOIN assets a ON a.rack_id = r.id
        GROUP BY r.id HAVING r.max_power_w IS NOT NULL
        ORDER BY coalesce(sum(a.power_draw_w), 0)::float / r.max_power_w DESC LIMIT 5`,
      db.$queryRaw<Array<{ eligible: bigint; covered: bigint }>>`
        WITH eligible AS (
          SELECT id FROM assets WHERE status IN ('active', 'maintenance')
            AND type IN ('physical_server', 'blade_server', 'switch', 'router', 'firewall', 'load_balancer', 'storage_array', 'pdu', 'ups')
        )
        SELECT count(*) AS eligible,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM contract_assets ca JOIN contracts c ON c.id = ca.contract_id
                 WHERE ca.asset_id = e.id AND c.contract_type IN ('warranty', 'support') AND current_date BETWEEN c.start_date AND c.end_date)) AS covered
        FROM eligible e`,
      db.$queryRaw<Array<{ d30: bigint; d90: bigint; expired: bigint }>>`
        SELECT count(*) FILTER (WHERE end_date BETWEEN current_date AND current_date + 30) AS d30,
               count(*) FILTER (WHERE end_date BETWEEN current_date AND current_date + 90) AS d90,
               count(*) FILTER (WHERE end_date < current_date AND end_date >= current_date - 30) AS expired
        FROM contracts`,
      // Usable hosts: IPv4 below /31 loses network and broadcast; IPv6 is capped so the maths stays finite.
      db.$queryRaw<Array<{ id: string; cidr: string; name: string | null; used: bigint; usable: number }>>`
        WITH s AS (
          SELECT id, cidr, name,
                 CASE WHEN family(cidr) = 4 AND masklen(cidr) < 31 THEN 2 ^ (32 - masklen(cidr)) - 2
                      WHEN family(cidr) = 4 THEN 2 ^ (32 - masklen(cidr))
                      ELSE 2 ^ least(64, 128 - masklen(cidr)) END AS usable
          FROM subnets
        )
        SELECT s.id, s.cidr::text AS cidr, s.name, count(i.id) AS used, s.usable
        FROM s LEFT JOIN ip_addresses i ON i.subnet_id = s.id AND i.status IN ('assigned', 'reserved', 'dhcp')
        GROUP BY s.id, s.cidr, s.name, s.usable
        ORDER BY count(i.id) / greatest(s.usable, 1) DESC, s.cidr LIMIT 5`,
      db.$queryRaw<Array<{ jobs: bigint; failing: bigint; conflicts: bigint; seen_7d: bigint; never: bigint }>>`
        SELECT (SELECT count(*) FROM discovery_jobs WHERE is_enabled) AS jobs,
               (SELECT count(*) FROM discovery_jobs WHERE is_enabled AND last_run_status IN ('failed', 'partial')) AS failing,
               (SELECT count(*) FROM discovery_results r
                  WHERE r.outcome = 'conflict' AND r.run_id IN (SELECT DISTINCT ON (job_id) id FROM discovery_runs ORDER BY job_id, queued_at DESC)) AS conflicts,
               (SELECT count(*) FROM assets WHERE last_discovered_at > now() - interval '7 days') AS seen_7d,
               (SELECT count(*) FROM assets WHERE last_discovered_at IS NULL AND type IN ('physical_server', 'virtual_machine', 'switch', 'router', 'firewall')) AS never`,
      db.$queryRaw<Array<{ succeeded: bigint; failing: bigint; dead: bigint }>>`
        SELECT count(*) FILTER (WHERE status = 'succeeded') AS succeeded, count(*) FILTER (WHERE status IN ('pending', 'failed')) AS failing,
               count(*) FILTER (WHERE status = 'dead') AS dead
        FROM webhook_deliveries WHERE created_at > now() - interval '24 hours'`,
    ]);
    const r = racks[0];
    const c = coverage[0];
    return {
      assets: { total: byStatus.reduce((s, x) => s + n(x.count), 0), byStatus: byStatus.map((x) => ({ status: x.status, count: n(x.count) })), byType: byType.map((x) => ({ type: x.type, count: n(x.count) })) },
      racks: {
        count: n(r.racks),
        totalU: n(r.total_u),
        usedU: Math.round(n(r.used_face_u) / 2),
        utilisationPct: n(r.total_u) ? Math.round((n(r.used_face_u) / 2 / n(r.total_u)) * 1000) / 10 : 0,
        hottest: hottest.map((h) => ({ id: h.id, name: h.name, loadW: n(h.load_w), maxPowerW: h.max_power_w, pct: h.max_power_w ? Math.round((n(h.load_w) / h.max_power_w) * 100) : null })),
      },
      coverage: { eligible: n(c.eligible), covered: n(c.covered), pct: n(c.eligible) ? Math.round((n(c.covered) / n(c.eligible)) * 100) : 100, expiringIn30: n(expiring[0].d30), expiringIn90: n(expiring[0].d90), expiredLast30: n(expiring[0].expired) },
      ipam: { busiest: subnets.map((s) => ({ id: s.id, cidr: s.cidr, name: s.name, used: n(s.used), usable: n(s.usable), pct: s.usable ? Math.round((n(s.used) / n(s.usable)) * 1000) / 10 : 0 })) },
      discovery: { enabledJobs: n(discovery[0].jobs), failingJobs: n(discovery[0].failing), openConflicts: n(discovery[0].conflicts), seenLast7d: n(discovery[0].seen_7d), neverDiscovered: n(discovery[0].never) },
      integrations: { last24h: { succeeded: n(deliveries[0].succeeded), retrying: n(deliveries[0].failing), dead: n(deliveries[0].dead) } },
    };
  }
}
