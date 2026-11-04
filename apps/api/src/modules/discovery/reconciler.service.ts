import { Injectable } from '@nestjs/common';
import type { ParsedHostFacts } from '@itam/shared';
import { Prisma } from '@prisma/client';
import { toDomainError } from '../../common/db-errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { toAssetDto } from '../assets/assets.service';
import { assetNameFor, inferType, isIdentityMac, resolveIdentity, servicePorts, swapUuidEndianness, type KnownAsset, type Match, type Outbound } from './reconcile';

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
    cloud: f.cloud,
    tags: f.tags && Object.keys(f.tags).length ? f.tags : undefined,
    // Listening ports let other hosts' sessions be told apart from ephemeral noise.
    listeners: f.listeners.length ? f.listeners.map((l) => l.port) : undefined,
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
    const uuids = f.systemUuid ? [f.systemUuid, swapUuidEndianness(f.systemUuid)] : [];
    const [byExternalId, bySystemUuid, bySerial, byMac, byIp] = await Promise.all([
      f.externalId ? tx.$queryRaw<KnownRow[]>`SELECT ${KNOWN_SELECT} FROM asset_external_ids x JOIN assets a ON a.id = x.asset_id WHERE x.external_id = ${f.externalId}` : [],
      uuids.length ? tx.$queryRaw<KnownRow[]>`SELECT ${KNOWN_SELECT} FROM assets a WHERE a.system_uuid = ANY(${uuids}::uuid[])` : [],
      f.serialNumber ? tx.$queryRaw<KnownRow[]>`SELECT ${KNOWN_SELECT} FROM assets a WHERE a.serial_number = ${f.serialNumber}` : [],
      macs.length
        ? tx.$queryRaw<KnownRow[]>`SELECT DISTINCT ${KNOWN_SELECT} FROM assets a JOIN network_ports p ON p.asset_id = a.id WHERE p.mac_address = ANY(${macs}::macaddr[])`
        : [],
      f.ip
        ? tx.$queryRaw<KnownRow[]>`
            SELECT ${KNOWN_SELECT} FROM ip_addresses i JOIN assets a ON a.id = i.asset_id
            WHERE i.ip = ${f.ip}::inet AND i.vrf_id IS NOT DISTINCT FROM ${vrfId}::uuid`
        : [],
    ]);
    return { byExternalId: byExternalId.map(known), bySystemUuid: bySystemUuid.map(known), bySerial: bySerial.map(known), byMac: byMac.map(known), byIp: byIp.map(known) };
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
    if (f.externalId) await this.linkExternalId(tx, assetId, f.externalId, changes);
    await this.syncPorts(tx, assetId, f, changes, hw);
    await this.syncComponents(tx, assetId, f, changes, hw);
    const ipNote = f.ip ? await this.syncIp(tx, assetId, f as ParsedHostFacts & { ip: string }, ctx.vrfId, changes) : null;
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

  /**
   * Turn a host's client-side sessions into depends_on edges to the assets owning the remote IPs.
   * Runs once per run, after every host is reconciled, so peers found in the same run resolve.
   * Idempotent per run (observations are counted once per run id); edges are never deleted
   * (an idle dependency shows as stale) and hand-made edges are never touched.
   */
  async syncDependencies(assetId: string, outbound: Outbound[], ctx: { userId: string; runId: string; vrfId: string | null; requestId?: string }) {
    if (!outbound.length) return { added: 0, refreshed: 0 };
    return this.prisma.$transaction(async (tx) => {
      const remotes = await tx.$queryRaw<Array<{ ip: string; asset_id: string; name: string; listeners: number[] | null }>>`
        SELECT host(i.ip) AS ip, a.id AS asset_id, a.name,
               (SELECT array_agg(value::int) FROM jsonb_array_elements_text(a.custom_fields->'discovery'->'listeners')) AS listeners
        FROM ip_addresses i JOIN assets a ON a.id = i.asset_id
        WHERE i.ip = ANY(${outbound.map((o) => o.remoteIp)}::inet[]) AND i.vrf_id IS NOT DISTINCT FROM ${ctx.vrfId}::uuid`;
      const byIp = new Map(remotes.map((r) => [r.ip, r]));

      // One remote asset can own several of the IPs; merge per target.
      const wanted = new Map<string, { ports: Set<number>; process: string | null }>();
      for (const o of outbound) {
        const r = byIp.get(o.remoteIp);
        if (!r || r.asset_id === assetId) continue;
        const ports = servicePorts(o.ports, r.listeners);
        if (!ports.length) continue;
        const w = wanted.get(r.asset_id) ?? { ports: new Set<number>(), process: o.process };
        ports.forEach((p) => w.ports.add(p));
        wanted.set(r.asset_id, w);
      }
      if (!wanted.size) return { added: 0, refreshed: 0 };

      const existing = await tx.ci_relationships.findMany({
        where: { source_asset_id: assetId, relationship_type: 'depends_on', target_asset_id: { in: [...wanted.keys()] } },
      });
      let added = 0;
      let refreshed = 0;
      const audit = { userId: ctx.userId, requestId: ctx.requestId };
      for (const [target, w] of wanted) {
        const ports = [...w.ports].sort((a, b) => a - b);
        const cur = existing.find((e) => e.target_asset_id === target);
        if (!cur) {
          const edge = await tx.ci_relationships.create({
            data: { source_asset_id: assetId, target_asset_id: target, relationship_type: 'depends_on', source: 'discovery', attributes: { ports, process: w.process, lastRunId: ctx.runId } },
          });
          await this.audit.record(tx, { entity: 'ci_relationship', entityId: edge.id, action: 'create', after: { source: assetId, target, type: 'depends_on', ports, process: w.process }, ...audit });
          added++;
          continue;
        }
        if (cur.source !== 'discovery') continue; // a person defined this edge; leave it alone
        const attrs = cur.attributes as { ports?: number[]; process?: string | null; lastRunId?: string };
        const prev = [...(attrs.ports ?? [])].sort((a, b) => a - b);
        const merged = [...new Set([...prev, ...ports])].sort((a, b) => a - b);
        const sameRun = attrs.lastRunId === ctx.runId;
        await tx.ci_relationships.update({
          where: { id: cur.id },
          data: {
            last_seen_at: new Date(),
            ...(sameRun ? {} : { observation_count: { increment: 1 } }),
            attributes: { ports: merged, process: w.process ?? attrs.process ?? null, lastRunId: ctx.runId },
          },
        });
        if (merged.length !== prev.length) {
          await this.audit.record(tx, { entity: 'ci_relationship', entityId: cur.id, action: 'update', before: { ports: prev }, after: { ports: merged }, ...audit });
        }
        refreshed++;
      }
      return { added, refreshed };
    }, TX_OPTIONS);
  }

  /** A provider id belongs to one asset; re-sightings only refresh last_seen. */
  private async linkExternalId(tx: Tx, assetId: string, externalId: string, changes: Record<string, unknown>) {
    const [r] = await tx.$queryRaw<Array<{ inserted: boolean }>>`
      INSERT INTO asset_external_ids (external_id, asset_id, source) VALUES (${externalId}, ${assetId}::uuid, split_part(${externalId}, ':', 1))
      ON CONFLICT (external_id) DO UPDATE SET last_seen_at = now() WHERE asset_external_ids.asset_id = EXCLUDED.asset_id
      RETURNING (xmax = 0) AS inserted`;
    if (r?.inserted) changes.externalId = externalId;
  }

  /**
   * VM → hypervisor host from inventory data. Same rules as dependencies: once per run, never
   * deleted automatically, hand-made edges untouched. The host must already be an asset (same run
   * or earlier).
   */
  async syncRunsOn(assetId: string, hostExternalId: string, ctx: { userId: string; runId: string; requestId?: string }) {
    return this.prisma.$transaction(async (tx) => {
      const [host] = await tx.$queryRaw<Array<{ asset_id: string }>>`SELECT asset_id FROM asset_external_ids WHERE external_id = ${hostExternalId}`;
      if (!host || host.asset_id === assetId) return false;
      // A VM runs on one host at a time: a vMotion moves the edge.
      const current = await tx.ci_relationships.findMany({ where: { source_asset_id: assetId, relationship_type: 'runs_on', source: 'discovery' } });
      const same = current.find((e) => e.target_asset_id === host.asset_id);
      for (const e of current.filter((x) => x.target_asset_id !== host.asset_id)) {
        await tx.ci_relationships.delete({ where: { id: e.id } });
        await this.audit.record(tx, { entity: 'ci_relationship', entityId: e.id, action: 'delete', before: { source: assetId, target: e.target_asset_id, type: 'runs_on', reason: 'moved to another host' }, userId: ctx.userId, requestId: ctx.requestId });
      }
      if (same) {
        const attrs = same.attributes as { lastRunId?: string };
        await tx.ci_relationships.update({ where: { id: same.id }, data: { last_seen_at: new Date(), ...(attrs.lastRunId === ctx.runId ? {} : { observation_count: { increment: 1 } }), attributes: { lastRunId: ctx.runId } } });
        return false;
      }
      const manual = await tx.ci_relationships.findFirst({ where: { source_asset_id: assetId, target_asset_id: host.asset_id, relationship_type: 'runs_on' } });
      if (manual) return false;
      const edge = await tx.ci_relationships.create({ data: { source_asset_id: assetId, target_asset_id: host.asset_id, relationship_type: 'runs_on', source: 'discovery', attributes: { lastRunId: ctx.runId } } });
      await this.audit.record(tx, { entity: 'ci_relationship', entityId: edge.id, action: 'create', after: { source: assetId, target: host.asset_id, type: 'runs_on' }, userId: ctx.userId, requestId: ctx.requestId });
      return true;
    }, TX_OPTIONS);
  }

  private async syncIp(tx: Tx, assetId: string, f: ParsedHostFacts & { ip: string }, vrfId: string | null, changes: Record<string, unknown>): Promise<string | null> {
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
