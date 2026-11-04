import { Injectable } from '@nestjs/common';
import type { AllocateIpInput, CreateSubnetInput, ReserveIpInput, SubnetSummary, SubnetTreeNode } from '@itam/shared';
import { toDomainError } from '../../common/db-errors';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { parseCidrStrict, parseIp, usableHosts, utilisationPct } from './cidr';

interface SubnetRow {
  id: string;
  cidr: string;
  name: string | null;
  description: string | null;
  vrf_id: string | null;
  vlan_id: string | null;
  parent_id: string | null;
  family: number;
  prefix: number;
  used: bigint | number;
}

interface IpRow {
  id: string;
  ip: string;
  subnet_id: string;
  asset_id: string | null;
  port_id: string | null;
  status: string;
  dns_name: string | null;
  description: string | null;
}

const toIpDto = (r: IpRow) => ({
  id: r.id,
  ip: r.ip,
  subnetId: r.subnet_id,
  assetId: r.asset_id,
  portId: r.port_id,
  status: r.status,
  dnsName: r.dns_name,
  description: r.description,
});

function toSummary(r: SubnetRow): SubnetSummary {
  const family = r.family === 4 ? 4 : 6;
  const total = usableHosts(family, r.prefix);
  const used = Number(r.used);
  return {
    id: r.id,
    cidr: r.cidr,
    name: r.name,
    vrfId: r.vrf_id,
    vlanId: r.vlan_id,
    parentId: r.parent_id,
    family,
    totalHosts: total.toString(),
    usedHosts: used,
    utilisationPct: utilisationPct(used, total),
  };
}

const SUBNET_SELECT = `
  SELECT s.id, s.cidr::text AS cidr, s.name, s.description, s.vrf_id, s.vlan_id, s.parent_id,
         family(s.cidr) AS family, masklen(s.cidr) AS prefix,
         (SELECT count(*) FROM ip_addresses i WHERE i.subnet_id = s.id) AS used
  FROM subnets s`;

@Injectable()
export class IpamService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async loadSubnet(tx: Tx, id: string, lock = false): Promise<SubnetRow> {
    const rows = await tx.$queryRawUnsafe<SubnetRow[]>(`${SUBNET_SELECT} WHERE s.id = $1::uuid ${lock ? 'FOR UPDATE OF s' : ''}`, id);
    if (rows.length === 0) throw notFound('Subnet', id);
    return rows[0];
  }

  async createSubnet(input: CreateSubnetInput, user: AuthUser, requestId?: string): Promise<SubnetSummary> {
    const parsed = parseCidrStrict(input.cidr);
    return this.prisma.$transaction(async (tx) => {
      let inserted: Array<{ id: string }>;
      try {
        inserted = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO subnets (cidr, name, description, vrf_id, vlan_id)
          VALUES (${parsed.cidr}::cidr, ${input.name ?? null}, ${input.description ?? null}, ${input.vrfId ?? null}::uuid, ${input.vlanId ?? null}::uuid)
          RETURNING id`;
      } catch (err) {
        const mapped = toDomainError(err);
        if (mapped?.code === 'DUPLICATE') {
          throw conflict('SUBNET_EXISTS', `${parsed.cidr} already exists in this VRF`, { cidr: parsed.cidr, vrfId: input.vrfId ?? null });
        }
        throw err;
      }
      const subnet = toSummary(await this.loadSubnet(tx, inserted[0].id));
      await this.audit.record(tx, { entity: 'subnet', entityId: subnet.id, action: 'create', after: { ...subnet }, userId: user.id, requestId });
      return subnet;
    }, TX_OPTIONS);
  }

  async getSubnet(id: string): Promise<SubnetSummary & { description: string | null }> {
    const row = await this.loadSubnet(this.prisma, id);
    return { ...toSummary(row), description: row.description };
  }

  async tree(vrfId?: string): Promise<SubnetTreeNode[]> {
    const rows = await this.prisma.$queryRawUnsafe<SubnetRow[]>(
      `${SUBNET_SELECT} WHERE ($1::uuid IS NULL AND s.vrf_id IS NULL) OR s.vrf_id = $1::uuid ORDER BY family(s.cidr), s.cidr`,
      vrfId ?? null,
    );
    const nodes = new Map<string, SubnetTreeNode>(rows.map((r) => [r.id, { ...toSummary(r), children: [] }]));
    const roots: SubnetTreeNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.parentId ? nodes.get(node.parentId) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  async listIps(subnetId: string) {
    await this.loadSubnet(this.prisma, subnetId);
    const rows = await this.prisma.$queryRaw<IpRow[]>`
      SELECT id, host(ip) AS ip, subnet_id, asset_id, port_id, status::text AS status, dns_name, description
      FROM ip_addresses WHERE subnet_id = ${subnetId}::uuid ORDER BY ip`;
    return rows.map(toIpDto);
  }

  /**
   * Next free address. The subnet row is locked FOR UPDATE, so concurrent allocations in one
   * subnet queue up and can never hand out the same IP. Ranges held by child subnets are skipped.
   */
  async allocate(subnetId: string, input: AllocateIpInput, user: AuthUser, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const subnet = await this.loadSubnet(tx, subnetId, true);
      const next = await tx.$queryRaw<Array<{ ip: string }>>`
        WITH s AS (
          SELECT cidr,
                 CASE WHEN family(cidr) = 4 AND masklen(cidr) < 31 THEN 1 ELSE 0 END AS edge,
                 CASE family(cidr) WHEN 4 THEN 32 ELSE 128 END AS hostlen
          FROM subnets WHERE id = ${subnetId}::uuid
        ),
        b AS (
          SELECT set_masklen(network(cidr)::inet, hostlen) + edge AS first_ip,
                 set_masklen(broadcast(cidr), hostlen) - edge AS last_ip
          FROM s
        ),
        used AS (
          SELECT ip AS lo, ip AS hi FROM ip_addresses WHERE subnet_id = ${subnetId}::uuid
          UNION ALL
          SELECT set_masklen(network(c.cidr)::inet, s.hostlen), set_masklen(broadcast(c.cidr), s.hostlen)
          FROM subnets c, s WHERE c.parent_id = ${subnetId}::uuid
        ),
        cand AS (
          SELECT first_ip AS ip FROM b
          UNION ALL
          SELECT u.hi + 1 FROM used u, b WHERE u.hi < b.last_ip
        )
        SELECT host(c.ip) AS ip
        FROM cand c, b
        WHERE c.ip BETWEEN b.first_ip AND b.last_ip
          AND NOT EXISTS (SELECT 1 FROM used u WHERE c.ip BETWEEN u.lo AND u.hi)
        ORDER BY c.ip
        LIMIT 1`;
      if (next.length === 0) {
        throw conflict('SUBNET_FULL', `No free addresses left in ${subnet.cidr}`, { subnetId, cidr: subnet.cidr });
      }
      return this.insertIp(tx, subnetId, next[0].ip, input, user, requestId);
    }, TX_OPTIONS);
  }

  async reserve(subnetId: string, input: ReserveIpInput, user: AuthUser, requestId?: string) {
    const { ip } = parseIp(input.ip);
    return this.prisma.$transaction(async (tx) => {
      await this.loadSubnet(tx, subnetId, true);
      return this.insertIp(tx, subnetId, ip, input, user, requestId);
    }, TX_OPTIONS);
  }

  async release(ipId: string, user: AuthUser, requestId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<IpRow[]>`
        DELETE FROM ip_addresses WHERE id = ${ipId}::uuid
        RETURNING id, host(ip) AS ip, subnet_id, asset_id, port_id, status::text AS status, dns_name, description`;
      if (rows.length === 0) throw notFound('IP address', ipId);
      await this.audit.record(tx, { entity: 'ip_address', entityId: ipId, action: 'delete', before: toIpDto(rows[0]), userId: user.id, requestId });
    }, TX_OPTIONS);
  }

  private async insertIp(tx: Tx, subnetId: string, ip: string, input: AllocateIpInput, user: AuthUser, requestId?: string) {
    let rows: IpRow[];
    try {
      rows = await tx.$queryRaw<IpRow[]>`
        INSERT INTO ip_addresses (ip, subnet_id, asset_id, port_id, status, dns_name, description)
        VALUES (${ip}::inet, ${subnetId}::uuid, ${input.assetId ?? null}::uuid, ${input.portId ?? null}::uuid,
                ${input.status}::ip_status, ${input.dnsName ?? null}, ${input.description ?? null})
        RETURNING id, host(ip) AS ip, subnet_id, asset_id, port_id, status::text AS status, dns_name, description`;
    } catch (err) {
      const mapped = toDomainError(err);
      if (mapped?.code === 'DUPLICATE') throw conflict('IP_IN_USE', `${ip} is already allocated in this VRF`, { ip });
      if (mapped?.code === 'IP_OUTSIDE_SUBNET' || mapped?.code === 'IP_RESERVED_ADDRESS') throw unprocessable(mapped.code, mapped.message, { ip });
      throw err;
    }
    const dto = toIpDto(rows[0]);
    await this.audit.record(tx, { entity: 'ip_address', entityId: dto.id, action: 'create', after: dto, userId: user.id, requestId });
    return dto;
  }
}
