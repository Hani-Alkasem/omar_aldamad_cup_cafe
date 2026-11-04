import { Injectable } from '@nestjs/common';
import type { ParsedHostFacts } from '@itam/shared';
import { Prisma } from '@prisma/client';
import { toDomainError } from '../../common/db-errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toAssetDto } from '../assets/assets.service';
import { assetNameFor, inferType, isIdentityMac, resolveIdentity, type KnownAsset, type Match } from './reconcile';

export interface ReconcileOutcome {
  outcome: 'created' | 'updated' | 'unchanged' | 'conflict';
  assetId: string | null;
  matchedBy: string | null;
  changes: Record<string, unknown>;
  message: string | null;
}

type Ctx = { userId: string; runId: string; vrfId: string | null; requestId?: string };

const KNOWN_SELECT = Prisma.sql`a.id, a.name, a.serial_number, a.system_uuid, a.custom_fields->'discovery'->>'sshHostKey' AS ssh_host_key`;
type KnownRow = { id: string; name: string; serial_number: string | null; system_uuid: string | null; ssh_host_key: string | null };
const known = (r: KnownRow): KnownAsset => ({ id: r.id, name: r.name, serialNumber: r.serial_number, systemUuid: r.system_uuid, sshHostKey: r.ssh_host_key });

/** Discovery-owned components carry this marker; hand-entered ones are never touched. */
const SOURCE = 'discovery';

function desiredComponents(f: ParsedHostFacts) {
  const out: Array<{ kind: string; slot: string | null; model: string | null; capacity: number }> = [];
  if (f.cpuCores) out.push({ kind: 'cpu', slot: null, model: null, capacity: f.cpuCores });
  if (f.memoryGb) out.push({ kind: 'memory', slot: null, model: null, capacity: Math.round(f.memoryGb * 10) / 10 });
  for (const d of f.disks) out.push({ kind: 'disk', slot: d.name, model: d.model ?? null, capacity: Math.round(d.sizeGb) });
  return out;
}
const signature = (cs: Array<{ kind: string; slot: string | null; model: string | null; capacity: number }>) =>
  JSON.stringify([...cs].sort((a, b) => `${a.kind}${a.slot}`.localeCompare(`${b.kind}${b.slot}`)));

/** Facts we keep on the asset (custom_fields.discovery). Volatile run bookkeeping is excluded from change detection. */
function discoveryBlock(f: ParsedHostFacts) {
  const block: Record<string, unknown> = {
    protocol: f.protocol,
    hostname: f.hostname,
    vendor: f.vendor,
    model: f.model,
    os: f.os,
    sysDescr: f.sysDescr,
    sysObjectId: f.sysObjectId,
    sshHostKey: f.sshHostKey,
  };
  for (const k of Object.keys(block)) if (block[k] === undefined) delete block[k];
  return block;
}

@Injectable()
export class ReconcilerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** One host, one transaction. A unique-key race with a parallel run is retried once against fresh state. */
  async reconcile(facts: ParsedHostFacts, ctx: Ctx): Promise<ReconcileOutcome> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.prisma.$transaction((tx) => this.apply(tx, facts, ctx), TX_OPTIONS);
      } catch (err) {
        if (attempt === 0 && toDomainError(err)?.code === 'DUPLICATE') continue;
        throw err;
      }
    }
  }

  private async lookups(tx: Tx, f: ParsedHostFacts, vrfId: string | null) {
    const macs = [...new Set(f.interfaces.map((i) => i.mac).filter((m): m is string => Boolean(m && isIdentityMac(m))))];
    const [bySystemUuid, bySerial, byMac, byIp] = await Promise.all([
      f.systemUuid ? tx.$queryRaw<KnownRow[]>`SELECT ${KNOWN_SELECT} FROM assets a WHERE a.system_uuid = ${f.systemUuid}::uuid` : [],
      f.serialNumber ? tx.$queryRaw<KnownRow[]>`SELECT ${KNOWN_SELECT} FROM assets a WHERE a.serial_number = ${f.serialNumber}` : [],
      macs.length
        ? tx.$queryRaw<KnownRow[]>`SELECT DISTINCT ${KNOWN_SELECT} FROM assets a JOIN network_ports p ON p.asset_id = a.id WHERE p.mac_address = ANY(${macs}::macaddr[])`
        : [],
      tx.$queryRaw<KnownRow[]>`
        SELECT ${KNOWN_SELECT} FROM ip_addresses i JOIN assets a ON a.id = i.asset_id
        WHERE i.ip = ${f.ip}::inet AND i.vrf_id IS NOT DISTINCT FROM ${vrfId}::uuid`,
    ]);
    return { bySystemUuid: bySystemUuid.map(known), bySerial: bySerial.map(known), byMac: byMac.map(known), byIp: byIp.map(known) };
  }

  private async apply(tx: Tx, f: ParsedHostFacts, ctx: Ctx): Promise<ReconcileOutcome> {
    const match: Match = resolveIdentity(f, await this.lookups(tx, f, ctx.vrfId));
    if (match.kind === 'conflict') {
      return { outcome: 'conflict', assetId: match.candidates[0]?.id ?? null, matchedBy: match.candidates[0]?.via ?? null, changes: { candidates: match.candidates }, message: match.reason };
    }

    const changes: Record<string, unknown> = {};
    let assetId: string;
    const audit = { userId: ctx.userId, requestId: ctx.requestId };

    if (match.kind === 'create') {
      const created = await tx.assets.create({
        data: {
          name: assetNameFor(f),
          type: inferType(f),
          status: 'active',
          serial_number: f.serialNumber ?? null,
          system_uuid: f.systemUuid ?? null,
          last_discovered_at: new Date(),
          custom_fields: { discovery: { ...discoveryBlock(f), firstRunId: ctx.runId } } as Prisma.InputJsonObject,
        },
      });
      assetId = created.id;
      await this.audit.record(tx, { entity: 'asset', entityId: assetId, action: 'create', after: toAssetDto(created), ...audit });
    } else {
      assetId = match.asset.id;
      const before = await tx.assets.findUniqueOrThrow({ where: { id: assetId } });
      const custom = (before.custom_fields ?? {}) as Record<string, unknown>;
      const prev = (custom.discovery ?? {}) as Record<string, unknown>;
      const next = { ...prev, ...discoveryBlock(f) };
      const data: Prisma.assetsUpdateInput = { last_discovered_at: new Date() };
      // Fill identifiers the asset lacks; never overwrite curated values (a mismatch was a conflict above).
      if (!before.serial_number && f.serialNumber) data.serial_number = changes.serialNumber = f.serialNumber;
      if (!before.system_uuid && f.systemUuid) data.system_uuid = changes.systemUuid = f.systemUuid;
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        changes.discovery = Object.keys(next).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]));
        data.custom_fields = { ...custom, discovery: next } as Prisma.InputJsonObject;
      }
      const after = await tx.assets.update({ where: { id: assetId }, data });
      if (Object.keys(changes).length) {
        await this.audit.record(tx, { entity: 'asset', entityId: assetId, action: 'update', before: toAssetDto(before), after: toAssetDto(after), ...audit });
      }
    }

    const hw = { before: {} as Record<string, unknown>, after: {} as Record<string, unknown> };
    await this.syncPorts(tx, assetId, f, changes, hw);
    await this.syncComponents(tx, assetId, f, changes, hw);
    const ipNote = await this.syncIp(tx, assetId, f, ctx.vrfId, changes);
    // Hardware changes are audited on the asset too, so its history explains why RAM "changed".
    if (Object.keys(hw.after).length) {
      await this.audit.record(tx, { entity: 'asset', entityId: assetId, action: 'update', before: hw.before, after: hw.after, ...audit });
    }

    const outcome = match.kind === 'create' ? 'created' : Object.keys(changes).length ? 'updated' : 'unchanged';
    return { outcome, assetId, matchedBy: match.kind === 'match' ? match.matchedBy : null, changes, message: ipNote };
  }

  private async syncPorts(tx: Tx, assetId: string, f: ParsedHostFacts, changes: Record<string, unknown>, hw: { before: Record<string, unknown>; after: Record<string, unknown> }) {
    if (!f.interfaces.length) return;
    const existing = await tx.$queryRaw<Array<{ port_name: string; mac: string | null; speed_mbps: number | null }>>`
      SELECT port_name, mac_address::text AS mac, speed_mbps FROM network_ports WHERE asset_id = ${assetId}::uuid`;
    const byName = new Map(existing.map((p) => [p.port_name, p]));
    const added: string[] = [];
    const updated: string[] = [];
    for (const i of f.interfaces) {
      const cur = byName.get(i.name);
      if (!cur) {
        await tx.$executeRaw`
          INSERT INTO network_ports (asset_id, port_name, mac_address, speed_mbps)
          VALUES (${assetId}::uuid, ${i.name}, ${i.mac ?? null}::macaddr, ${i.speedMbps ?? null}::int)`;
        added.push(i.name);
      } else if ((i.mac && cur.mac !== i.mac) || (i.speedMbps && cur.speed_mbps !== i.speedMbps)) {
        await tx.$executeRaw`
          UPDATE network_ports SET mac_address = COALESCE(${i.mac ?? null}::macaddr, mac_address), speed_mbps = COALESCE(${i.speedMbps ?? null}::int, speed_mbps)
          WHERE asset_id = ${assetId}::uuid AND port_name = ${i.name}`;
        updated.push(i.name);
      }
    }
    // Ports that vanished are left in place: they may be cabled, and an interface that is down is not gone.
    if (added.length || updated.length) {
      changes.ports = { added, updated };
      hw.before.ports = existing.map((p) => ({ name: p.port_name, mac: p.mac, speedMbps: p.speed_mbps }));
      hw.after.ports = f.interfaces.map((i) => ({ name: i.name, mac: i.mac ?? null, speedMbps: i.speedMbps ?? null }));
    }
  }

  private async syncComponents(tx: Tx, assetId: string, f: ParsedHostFacts, changes: Record<string, unknown>, hw: { before: Record<string, unknown>; after: Record<string, unknown> }) {
    const want = desiredComponents(f);
    if (!want.length) return;
    const have = await tx.asset_components.findMany({ where: { asset_id: assetId, attributes: { path: ['source'], equals: SOURCE } } });
    const haveSig = signature(have.map((c) => ({ kind: c.kind, slot: c.slot, model: c.model, capacity: Number(c.capacity) })));
    if (haveSig === signature(want)) return;
    await tx.asset_components.deleteMany({ where: { id: { in: have.map((c) => c.id) } } });
    await tx.asset_components.createMany({ data: want.map((c) => ({ asset_id: assetId, ...c, attributes: { source: SOURCE } })) });
    changes.components = { before: have.length, after: want.length };
    hw.before.discoveredComponents = JSON.parse(haveSig);
    hw.after.discoveredComponents = JSON.parse(signature(want));
  }

  private async syncIp(tx: Tx, assetId: string, f: ParsedHostFacts, vrfId: string | null, changes: Record<string, unknown>): Promise<string | null> {
    const [subnet] = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM subnets WHERE cidr >>= ${f.ip}::inet AND vrf_id IS NOT DISTINCT FROM ${vrfId}::uuid ORDER BY masklen(cidr) DESC LIMIT 1`;
    if (!subnet) return `No subnet in IPAM contains ${f.ip}; address not recorded`;
    const [cur] = await tx.$queryRaw<Array<{ id: string; asset_id: string | null; status: string }>>`
      SELECT id, asset_id, status FROM ip_addresses WHERE ip = ${f.ip}::inet AND vrf_id IS NOT DISTINCT FROM ${vrfId}::uuid FOR UPDATE`;
    if (!cur) {
      await tx.$executeRaw`
        INSERT INTO ip_addresses (ip, subnet_id, asset_id, status, dns_name, last_seen_at)
        VALUES (${f.ip}::inet, ${subnet.id}::uuid, ${assetId}::uuid, 'assigned', ${f.hostname ?? null}, now())`;
      changes.ip = { assigned: f.ip };
      return null;
    }
    if (cur.asset_id !== assetId) changes.ip = { reassigned: f.ip, fromAssetId: cur.asset_id };
    // A reserved address that answers is now in use; DHCP addresses keep their status.
    await tx.$executeRaw`
      UPDATE ip_addresses SET asset_id = ${assetId}::uuid, last_seen_at = now(),
             status = CASE WHEN status = 'dhcp' THEN status ELSE 'assigned'::ip_status END
      WHERE id = ${cur.id}::uuid`;
    return null;
  }
}
