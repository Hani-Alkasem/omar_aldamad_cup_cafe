import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma.service';
import { classify } from './classify';

export interface SearchHit {
  type: 'asset' | 'ip' | 'subnet' | 'application' | 'rack' | 'contract';
  id: string;
  title: string;
  subtitle: string;
  href: string;
  score: number;
  matched: string;
}

/**
 * One box for everything: names, tags, serials, IPs, CIDRs, MACs and UUIDs. The query's shape picks
 * the lookups; text uses trigram similarity so "esx01" still finds "esx-01".
 */
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(raw: string, limit = 25): Promise<{ query: string; kind: string; hits: SearchHit[] }> {
    const q = classify(raw);
    const hits: SearchHit[] = [];
    const asset = (r: { id: string; name: string; type: string; asset_tag: string | null; serial_number: string | null }, score: number, matched: string): SearchHit => ({
      type: 'asset',
      id: r.id,
      title: r.name,
      subtitle: [r.type.replace(/_/g, ' '), r.asset_tag, r.serial_number && `S/N ${r.serial_number}`].filter(Boolean).join(' · '),
      href: `/assets/${r.id}`,
      score,
      matched,
    });

    if (q.kind === 'uuid') {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; name: string; type: string; asset_tag: string | null; serial_number: string | null }>>`
        SELECT id, name, type, asset_tag, serial_number FROM assets WHERE id = ${q.id}::uuid OR system_uuid = ${q.id}::uuid`;
      hits.push(...rows.map((r) => asset(r, 1, r.id === q.id ? 'id' : 'system UUID')));
    }

    if (q.kind === 'ip' || q.kind === 'cidr') {
      const target = q.kind === 'ip' ? q.ip : q.cidr;
      const ips = await this.prisma.$queryRaw<Array<{ id: string; ip: string; status: string; asset_id: string | null; asset_name: string | null; subnet: string; dns_name: string | null }>>`
        SELECT i.id, host(i.ip) AS ip, i.status, i.asset_id, a.name AS asset_name, s.cidr::text AS subnet, i.dns_name
        FROM ip_addresses i JOIN subnets s ON s.id = i.subnet_id LEFT JOIN assets a ON a.id = i.asset_id
        WHERE i.ip <<= ${target}::inet ORDER BY i.ip LIMIT ${limit}`;
      for (const r of ips) {
        hits.push({
          type: 'ip', id: r.id, title: r.ip, subtitle: [r.status, r.asset_name, r.dns_name, `in ${r.subnet}`].filter(Boolean).join(' · '),
          href: r.asset_id ? `/assets/${r.asset_id}` : `/search?q=${encodeURIComponent(r.subnet)}`, score: r.ip === target ? 1 : 0.8, matched: 'address',
        });
      }
      // The subnets that contain an address, or are inside / equal to a CIDR.
      const subnets = await this.prisma.$queryRaw<Array<{ id: string; cidr: string; name: string | null; masklen: number }>>`
        SELECT id, cidr::text AS cidr, name, masklen(cidr) AS masklen FROM subnets
        WHERE cidr >>= ${target}::inet OR cidr <<= ${target}::inet ORDER BY masklen(cidr) DESC LIMIT ${limit}`;
      hits.push(...subnets.map((s, i) => ({ type: 'subnet' as const, id: s.id, title: s.cidr, subtitle: s.name ?? 'subnet', href: `/search?q=${encodeURIComponent(s.cidr)}`, score: 0.9 - i * 0.01, matched: 'network' })));
    }

    if (q.kind === 'mac') {
      const rows = await this.prisma.$queryRaw<Array<{ id: string; name: string; type: string; asset_tag: string | null; serial_number: string | null; port_name: string }>>`
        SELECT a.id, a.name, a.type, a.asset_tag, a.serial_number, p.port_name FROM network_ports p JOIN assets a ON a.id = p.asset_id
        WHERE p.mac_address = ${q.mac}::macaddr LIMIT ${limit}`;
      hits.push(...rows.map((r) => ({ ...asset(r, 1, `MAC on ${r.port_name}`) })));
    }

    if (q.kind === 'text' || (q.kind === 'mac' && q.alsoText)) {
      const text = q.kind === 'text' ? q.text : raw.trim();
      const t = text.toLowerCase();
      // Exact tag/serial first, then prefix, then fuzzy name; similarity breaks ties.
      const assets = await this.prisma.$queryRaw<Array<{ id: string; name: string; type: string; asset_tag: string | null; serial_number: string | null; score: number; matched: string }>>`
        SELECT id, name, type, asset_tag, serial_number,
               GREATEST(
                 CASE WHEN lower(asset_tag) = ${t} OR lower(serial_number) = ${t} THEN 1.0 ELSE 0 END,
                 CASE WHEN lower(name) = ${t} THEN 0.98 WHEN lower(name) LIKE ${`${t}%`} THEN 0.9 ELSE 0 END,
                 similarity(lower(name), ${t}), similarity(coalesce(lower(asset_tag), ''), ${t}), similarity(coalesce(lower(serial_number), ''), ${t})
               )::float AS score,
               CASE WHEN lower(asset_tag) = ${t} THEN 'asset tag' WHEN lower(serial_number) = ${t} THEN 'serial' ELSE 'name' END AS matched
        FROM assets
        WHERE lower(name) % ${t} OR lower(name) LIKE ${`%${t}%`} OR lower(asset_tag) LIKE ${`${t}%`} OR lower(serial_number) LIKE ${`${t}%`}
        ORDER BY score DESC, name LIMIT ${limit}`;
      hits.push(...assets.map((r) => asset(r, r.score, r.matched)));

      const others = await this.prisma.$queryRaw<Array<{ type: SearchHit['type']; id: string; title: string; subtitle: string; score: number }>>`
        SELECT 'application' AS type, id::text, name AS title, criticality::text AS subtitle, similarity(lower(name), ${t})::float AS score
          FROM applications WHERE lower(name) % ${t} OR lower(name) LIKE ${`%${t}%`}
        UNION ALL
        SELECT 'rack', id::text, name, height_u || 'U rack', similarity(lower(name), ${t})::float FROM racks WHERE lower(name) % ${t} OR lower(name) LIKE ${`%${t}%`}
        UNION ALL
        SELECT 'subnet', id::text, cidr::text, coalesce(name, ''), similarity(lower(coalesce(name, '')), ${t})::float FROM subnets WHERE lower(name) % ${t} OR lower(name) LIKE ${`%${t}%`}
        UNION ALL
        SELECT 'contract', id::text, contract_number, contract_type::text || ' contract, ends ' || end_date, similarity(lower(contract_number), ${t})::float
          FROM contracts WHERE lower(contract_number) % ${t} OR lower(contract_number) LIKE ${`%${t}%`}
        ORDER BY score DESC LIMIT ${limit}`;
      const href = (o: (typeof others)[number]) => ({ application: `/applications/${o.id}`, rack: `/racks/${o.id}`, subnet: `/search?q=${encodeURIComponent(o.title)}`, contract: '/contracts', asset: '', ip: '' })[o.type];
      // Slightly below assets of equal similarity: assets are what people search for most.
      hits.push(...others.map((o) => ({ ...o, score: Math.min(o.score, 0.95) * 0.97, href: href(o), matched: 'name' })));
    }

    const seen = new Set<string>();
    const unique = hits.filter((h) => (seen.has(`${h.type}:${h.id}`) ? false : seen.add(`${h.type}:${h.id}`)));
    unique.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return { query: raw, kind: q.kind, hits: unique.slice(0, limit) };
  }
}
