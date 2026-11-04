import { Injectable } from '@nestjs/common';
import type { BulkPowerPortsInput, ConnectPowerInput, RackPowerSummary } from '@itam/shared';
import { toDomainError } from '../../common/db-errors';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { PrismaService, TX_OPTIONS } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { computeRackPower } from './power-budget';

const portDto = (p: { id: string; asset_id: string; name: string; kind: 'inlet' | 'outlet'; feed: 'A' | 'B' | 'C' | null; voltage: number; max_amps: unknown }) => ({
  id: p.id,
  assetId: p.asset_id,
  name: p.name,
  kind: p.kind,
  feed: p.feed,
  voltage: p.voltage,
  maxAmps: p.max_amps == null ? null : Number(p.max_amps),
});

@Injectable()
export class PowerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async listPorts(assetId: string) {
    if (!(await this.prisma.assets.findUnique({ where: { id: assetId }, select: { id: true } }))) throw notFound('Asset', assetId);
    const ports = await this.prisma.power_ports.findMany({
      where: { asset_id: assetId },
      include: {
        power_connections_power_connections_outlet_port_idTopower_ports: { include: { power_ports_power_connections_inlet_port_idTopower_ports: { include: { assets: { select: { id: true, name: true } } } } } },
        power_connections_power_connections_inlet_port_idTopower_ports: { include: { power_ports_power_connections_outlet_port_idTopower_ports: { include: { assets: { select: { id: true, name: true } } } } } },
      },
    });
    const collator = new Intl.Collator('en', { numeric: true });
    return ports
      .map((p) => {
        const out = p.power_connections_power_connections_outlet_port_idTopower_ports;
        const inn = p.power_connections_power_connections_inlet_port_idTopower_ports;
        const conn = out
          ? { id: out.id, peerPortId: out.inlet_port_id, peerPortName: out.power_ports_power_connections_inlet_port_idTopower_ports.name, peerAsset: out.power_ports_power_connections_inlet_port_idTopower_ports.assets }
          : inn
            ? { id: inn.id, peerPortId: inn.outlet_port_id, peerPortName: inn.power_ports_power_connections_outlet_port_idTopower_ports.name, peerAsset: inn.power_ports_power_connections_outlet_port_idTopower_ports.assets }
            : null;
        return { ...portDto(p), connection: conn };
      })
      .sort((a, b) => (a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'inlet' ? -1 : 1));
  }

  async bulkPorts(assetId: string, input: BulkPowerPortsInput, user: AuthUser, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      const asset = await tx.assets.findUnique({ where: { id: assetId }, select: { id: true, type: true } });
      if (!asset) throw notFound('Asset', assetId);
      if (input.kind === 'outlet' && !['pdu', 'ups'].includes(asset.type)) {
        throw unprocessable('NOT_A_POWER_SOURCE', 'Only PDUs and UPSes have outlets');
      }
      try {
        await tx.power_ports.createMany({
          data: Array.from({ length: input.count }, (_, i) => ({
            asset_id: assetId,
            name: `${input.prefix}${i + 1}`,
            kind: input.kind,
            feed: input.feed ?? null,
            voltage: input.voltage,
            max_amps: input.maxAmps ?? null,
          })),
        });
      } catch (err) {
        if (toDomainError(err)?.code === 'DUPLICATE') throw conflict('POWER_PORT_EXISTS', 'A power port with that name already exists');
        throw err;
      }
      await this.audit.record(tx, { entity: 'asset', entityId: assetId, action: 'update', before: { powerPortsAdded: 0 }, after: { powerPortsAdded: input.count, kind: input.kind }, userId: user.id, requestId });
      return tx.power_ports.findMany({ where: { asset_id: assetId }, orderBy: { name: 'asc' } }).then((ps) => ps.map(portDto));
    }, TX_OPTIONS);
  }

  async connect(input: ConnectPowerInput, user: AuthUser, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      for (const id of [input.outletPortId, input.inletPortId]) {
        if (!(await tx.power_ports.findUnique({ where: { id } }))) throw notFound('Power port', id);
      }
      const busy = await tx.power_connections.findFirst({ where: { OR: [{ outlet_port_id: input.outletPortId }, { inlet_port_id: input.inletPortId }] } });
      if (busy) throw conflict('POWER_PORT_IN_USE', busy.outlet_port_id === input.outletPortId ? 'That outlet already has a cord' : 'That inlet is already plugged in', { connectionId: busy.id });

      let conn;
      try {
        conn = await tx.power_connections.create({ data: { outlet_port_id: input.outletPortId, inlet_port_id: input.inletPortId } });
      } catch (err) {
        const d = toDomainError(err);
        if (d?.code === 'DUPLICATE') throw conflict('POWER_PORT_IN_USE', 'Outlet or inlet was connected concurrently');
        throw d ?? err;
      }
      const dto = { id: conn.id, outletPortId: conn.outlet_port_id, inletPortId: conn.inlet_port_id };
      await this.audit.record(tx, { entity: 'power_connection', entityId: conn.id, action: 'create', after: dto, userId: user.id, requestId });
      return dto;
    }, TX_OPTIONS);
  }

  async disconnect(id: string, user: AuthUser, requestId?: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.power_connections.findUnique({ where: { id } });
      if (!c) throw notFound('Power connection', id);
      await tx.power_connections.delete({ where: { id } });
      await this.audit.record(tx, { entity: 'power_connection', entityId: id, action: 'delete', before: { id, outletPortId: c.outlet_port_id, inletPortId: c.inlet_port_id }, userId: user.id, requestId });
    }, TX_OPTIONS);
  }

  async rackPower(rackId: string): Promise<RackPowerSummary> {
    const rack = await this.prisma.racks.findUnique({ where: { id: rackId }, select: { id: true, max_power_w: true } });
    if (!rack) throw notFound('Rack', rackId);
    const devices = await this.prisma.assets.findMany({ where: { rack_id: rackId }, select: { id: true, name: true, type: true, power_draw_w: true } });
    const ids = devices.map((d) => d.id);
    const ports = await this.prisma.power_ports.findMany({ where: { asset_id: { in: ids } } });
    const portIds = ports.map((p) => p.id);
    const conns = await this.prisma.power_connections.findMany({ where: { OR: [{ outlet_port_id: { in: portIds } }, { inlet_port_id: { in: portIds } }] } });
    return computeRackPower(
      rack.id,
      rack.max_power_w,
      devices.map((d) => ({ id: d.id, name: d.name, type: d.type, powerW: d.power_draw_w })),
      ports.map((p) => ({ id: p.id, assetId: p.asset_id, kind: p.kind, feed: p.feed, voltage: p.voltage, maxAmps: p.max_amps == null ? null : Number(p.max_amps) })),
      conns.map((c) => ({ outletPortId: c.outlet_port_id, inletPortId: c.inlet_port_id })),
    );
  }
}
