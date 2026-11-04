import { Injectable } from '@nestjs/common';
import type { BulkPortsInput, CableMedia, CreateCableInput, CreatePortInput, PortKind, TraceResult } from '@itam/shared';
import { toDomainError } from '../../common/db-errors';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { tracePath, type TraceCable, type TracePort } from './trace';

interface PortRow {
  id: string;
  asset_id: string;
  asset_name: string;
  port_name: string;
  kind: PortKind;
  position: number | null;
  mac_address: string | null;
  speed_mbps: number | null;
  vlan_id: string | null;
  is_uplink: boolean;
  pass_through_port_id: string | null;
  cable_id: string | null;
  remote_port_id: string | null;
  remote_port_name: string | null;
  remote_asset_id: string | null;
  remote_asset_name: string | null;
}

const PORT_SELECT = `
  SELECT p.id, p.asset_id, a.name AS asset_name, p.port_name, p.kind, p.position,
         p.mac_address::text AS mac_address, p.speed_mbps, p.vlan_id, p.is_uplink, p.pass_through_port_id,
         c.id AS cable_id, rp.id AS remote_port_id, rp.port_name AS remote_port_name,
         ra.id AS remote_asset_id, ra.name AS remote_asset_name
  FROM network_ports p
  JOIN assets a ON a.id = p.asset_id
  LEFT JOIN cables c ON c.a_port_id = p.id OR c.b_port_id = p.id
  LEFT JOIN network_ports rp ON rp.id = CASE WHEN c.a_port_id = p.id THEN c.b_port_id ELSE c.a_port_id END
  LEFT JOIN assets ra ON ra.id = rp.asset_id`;

const portDto = (r: PortRow) => ({
  id: r.id,
  assetId: r.asset_id,
  assetName: r.asset_name,
  portName: r.port_name,
  kind: r.kind,
  position: r.position,
  macAddress: r.mac_address,
  speedMbps: r.speed_mbps,
  vlanId: r.vlan_id,
  isUplink: r.is_uplink,
  passThroughPortId: r.pass_through_port_id,
  cable: r.cable_id
    ? { id: r.cable_id, remotePortId: r.remote_port_id, remotePortName: r.remote_port_name, remoteAssetId: r.remote_asset_id, remoteAssetName: r.remote_asset_name }
    : null,
});

/** Natural sort so eth2 comes before eth10. */
const collator = new Intl.Collator('en', { numeric: true });

@Injectable()
export class CablingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async ports(tx: Tx, where: string, ...params: unknown[]) {
    const rows = await tx.$queryRawUnsafe<PortRow[]>(`${PORT_SELECT} WHERE ${where}`, ...params);
    return rows.map(portDto).sort((a, b) => collator.compare(a.portName, b.portName));
  }

  private async requireAsset(tx: Tx, assetId: string) {
    const a = await tx.assets.findUnique({ where: { id: assetId }, select: { id: true, type: true } });
    if (!a) throw notFound('Asset', assetId);
    return a;
  }

  listPorts(assetId: string) {
    return this.requireAsset(this.prisma, assetId).then(() => this.ports(this.prisma, 'p.asset_id = $1::uuid', assetId));
  }

  /** Where is this MAC plugged in? Groundwork for ARP/CAM-table switch-port mapping. */
  findByMac(mac: string) {
    return this.ports(this.prisma, 'p.mac_address = $1::macaddr', mac);
  }

  private mapPortError(err: unknown, assetId: string): never {
    const d = toDomainError(err);
    if (d?.code === 'DUPLICATE') throw conflict('PORT_EXISTS', 'A port with that name or position already exists on this asset', { assetId });
    throw err;
  }

  async createPort(assetId: string, input: CreatePortInput, user: AuthUser, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      await this.requireAsset(tx, assetId);
      let id: string;
      try {
        [{ id }] = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO network_ports (asset_id, port_name, kind, position, mac_address, speed_mbps, vlan_id, is_uplink)
          VALUES (${assetId}::uuid, ${input.portName}, ${input.kind}::port_kind, ${input.position ?? null}::smallint,
                  ${input.macAddress ?? null}::macaddr, ${input.speedMbps ?? null}::int, ${input.vlanId ?? null}::uuid, ${input.isUplink})
          RETURNING id`;
      } catch (err) {
        this.mapPortError(err, assetId);
      }
      const [port] = await this.ports(tx, 'p.id = $1::uuid', id);
      await this.audit.record(tx, { entity: 'network_port', entityId: id, action: 'create', after: port, userId: user.id, requestId });
      return port;
    }, TX_OPTIONS);
  }

  /** eth1..eth48, or a patch panel's front N + rear N ports paired through. */
  async bulkPorts(assetId: string, input: BulkPortsInput, user: AuthUser, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const asset = await this.requireAsset(tx, assetId);
      if (input.patchPanel && asset.type !== 'patch_panel') {
        throw unprocessable('NOT_A_PATCH_PANEL', 'patchPanel ports can only be added to a patch_panel asset');
      }
      const numbers = Array.from({ length: input.count }, (_, i) => input.start + i);
      try {
        if (input.patchPanel) {
          for (const n of numbers) {
            const [{ id: rear }] = await tx.$queryRaw<Array<{ id: string }>>`
              INSERT INTO network_ports (asset_id, port_name, kind, position) VALUES (${assetId}::uuid, ${`${input.prefix}${n}-R`}, 'patch_rear', ${n}::smallint) RETURNING id`;
            await tx.$executeRaw`
              INSERT INTO network_ports (asset_id, port_name, kind, position, pass_through_port_id)
              VALUES (${assetId}::uuid, ${`${input.prefix}${n}`}, 'patch_front', ${n}::smallint, ${rear}::uuid)`;
          }
        } else {
          for (const n of numbers) {
            await tx.$executeRaw`
              INSERT INTO network_ports (asset_id, port_name, kind, position, speed_mbps)
              VALUES (${assetId}::uuid, ${`${input.prefix}${n}`}, ${input.kind}::port_kind, ${n}::smallint, ${input.speedMbps ?? null}::int)`;
          }
        }
      } catch (err) {
        this.mapPortError(err, assetId);
      }
      const ports = await this.ports(tx, 'p.asset_id = $1::uuid', assetId);
      await this.audit.record(tx, {
        entity: 'asset',
        entityId: assetId,
        action: 'update',
        before: { portCount: ports.length - numbers.length * (input.patchPanel ? 2 : 1) },
        after: { portCount: ports.length },
        userId: user.id,
        requestId,
      });
      return ports;
    }, TX_OPTIONS);
  }

  async deletePort(id: string, user: AuthUser, requestId?: string) {
    await this.prisma.$transaction(async (tx) => {
      const [port] = await this.ports(tx, 'p.id = $1::uuid', id);
      if (!port) throw notFound('Port', id);
      if (port.cable) throw conflict('PORT_CABLED', `Disconnect cable from ${port.portName} first`, { cableId: port.cable.id });
      await tx.$executeRaw`DELETE FROM network_ports WHERE id = ${id}::uuid`;
      await this.audit.record(tx, { entity: 'network_port', entityId: id, action: 'delete', before: port, userId: user.id, requestId });
    }, TX_OPTIONS);
  }

  async connect(input: CreateCableInput, user: AuthUser, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      // Lock both ports so two technicians cannot cable the same port at once.
      const locked = await tx.$queryRaw<Array<{ id: string; kind: PortKind }>>`
        SELECT id, kind FROM network_ports WHERE id IN (${input.aPortId}::uuid, ${input.bPortId}::uuid) ORDER BY id FOR UPDATE`;
      for (const id of [input.aPortId, input.bPortId]) if (!locked.some((p) => p.id === id)) throw notFound('Port', id);

      const busy = await this.ports(tx, '(p.id = $1::uuid OR p.id = $2::uuid) AND c.id IS NOT NULL', input.aPortId, input.bPortId);
      if (busy.length) {
        throw conflict('PORT_IN_USE', `${busy.map((p) => `${p.assetName} ${p.portName}`).join(' and ')} already cabled`, {
          ports: busy.map((p) => ({ portId: p.id, cableId: p.cable?.id, remote: p.cable?.remoteAssetName })),
        });
      }

      let id: string;
      try {
        [{ id }] = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO cables (a_port_id, b_port_id, media, label, length_m, circuit_id)
          VALUES (${input.aPortId}::uuid, ${input.bPortId}::uuid, ${input.media}::cable_media, ${input.label ?? null},
                  ${input.lengthM ?? null}::numeric, ${input.circuitId ?? null})
          RETURNING id`;
      } catch (err) {
        if (toDomainError(err)?.code === 'DUPLICATE') throw conflict('PORT_IN_USE', 'One of the ports was cabled concurrently');
        throw err;
      }
      const cable = await this.cable(tx, id);
      await this.audit.record(tx, { entity: 'cable', entityId: id, action: 'create', after: cable, userId: user.id, requestId });
      return cable;
    }, TX_OPTIONS);
  }

  private async cable(tx: Tx, id: string) {
    const [c] = await tx.$queryRaw<Array<{ id: string; a_port_id: string; b_port_id: string; media: CableMedia; label: string | null; length_m: string | null; circuit_id: string | null }>>`
      SELECT id, a_port_id, b_port_id, media, label, length_m::text, circuit_id FROM cables WHERE id = ${id}::uuid`;
    if (!c) return undefined;
    return { id: c.id, aPortId: c.a_port_id, bPortId: c.b_port_id, media: c.media, label: c.label, lengthM: c.length_m == null ? null : Number(c.length_m), circuitId: c.circuit_id };
  }

  async disconnect(id: string, user: AuthUser, requestId?: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await this.cable(tx, id);
      if (!c) throw notFound('Cable', id);
      await tx.$executeRaw`DELETE FROM cables WHERE id = ${id}::uuid`;
      await this.audit.record(tx, { entity: 'cable', entityId: id, action: 'delete', before: c, userId: user.id, requestId });
    }, TX_OPTIONS);
  }

  async trace(portId: string): Promise<TraceResult> {
    const result = await tracePath(portId, {
      port: async (id) => {
        const [r] = await this.prisma.$queryRaw<Array<{ id: string; port_name: string; kind: PortKind; asset_id: string; asset_name: string; pass_through_port_id: string | null }>>`
          SELECT p.id, p.port_name, p.kind, p.asset_id, a.name AS asset_name, p.pass_through_port_id
          FROM network_ports p JOIN assets a ON a.id = p.asset_id WHERE p.id = ${id}::uuid`;
        return r ? ({ id: r.id, portName: r.port_name, kind: r.kind, assetId: r.asset_id, assetName: r.asset_name, passThroughPortId: r.pass_through_port_id } satisfies TracePort) : undefined;
      },
      cableAt: async (id) => {
        const [c] = await this.prisma.$queryRaw<Array<{ id: string; a_port_id: string; b_port_id: string; media: CableMedia; label: string | null }>>`
          SELECT id, a_port_id, b_port_id, media, label FROM cables WHERE a_port_id = ${id}::uuid OR b_port_id = ${id}::uuid`;
        return c ? ({ id: c.id, aPortId: c.a_port_id, bPortId: c.b_port_id, media: c.media, label: c.label } satisfies TraceCable) : undefined;
      },
    });
    if (!result) throw notFound('Port', portId);
    return result;
  }
}
