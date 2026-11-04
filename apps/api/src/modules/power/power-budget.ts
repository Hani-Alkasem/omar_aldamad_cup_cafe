import { WATTS_TO_BTU_HR, type PduLoad, type PowerFeed, type RackPowerSummary } from '@itam/shared';

export interface BudgetDevice {
  id: string;
  name: string;
  type: string;
  powerW: number | null;
}

export interface BudgetPort {
  id: string;
  assetId: string;
  kind: 'inlet' | 'outlet';
  feed: PowerFeed | null;
  voltage: number;
  maxAmps: number | null;
}

export interface BudgetConnection {
  outletPortId: string;
  inletPortId: string;
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const NON_CONSUMERS = new Set(['pdu', 'patch_panel']);

/**
 * Rack power budget. A device's draw is split evenly across its connected inlets (A/B redundant
 * supplies share load), then summed per PDU. PDU rating comes from the PDU's own inlet amps.
 */
export function computeRackPower(rackId: string, maxPowerW: number | null, devices: BudgetDevice[], ports: BudgetPort[], conns: BudgetConnection[]): RackPowerSummary {
  const portById = new Map(ports.map((p) => [p.id, p]));
  const connByInlet = new Map(conns.map((c) => [c.inletPortId, c]));
  const deviceById = new Map(devices.map((d) => [d.id, d]));

  const connectedInlets = (assetId: string) => ports.filter((p) => p.assetId === assetId && p.kind === 'inlet' && connByInlet.has(p.id));

  const pdus: PduLoad[] = devices
    .filter((d) => ports.some((p) => p.assetId === d.id && p.kind === 'outlet'))
    .map((pdu) => {
      const outlets = ports.filter((p) => p.assetId === pdu.id && p.kind === 'outlet');
      const outletIds = new Set(outlets.map((o) => o.id));
      const used = conns.filter((c) => outletIds.has(c.outletPortId));
      let loadW = 0;
      for (const c of used) {
        const inlet = portById.get(c.inletPortId);
        const consumer = inlet && deviceById.get(inlet.assetId);
        if (!inlet || !consumer?.powerW) continue;
        loadW += consumer.powerW / Math.max(1, connectedInlets(consumer.id).length);
      }
      const voltage = outlets[0]?.voltage ?? 230;
      const ratedA = ports.filter((p) => p.assetId === pdu.id && p.kind === 'inlet' && p.maxAmps != null).reduce((s, p) => s + (p.maxAmps ?? 0), 0) || null;
      const loadA = round1(loadW / voltage);
      return {
        pduId: pdu.id,
        pduName: pdu.name,
        feed: outlets.find((o) => o.feed)?.feed ?? null,
        outletsTotal: outlets.length,
        outletsUsed: used.length,
        loadW: Math.round(loadW),
        loadA,
        ratedA,
        utilisationPct: ratedA ? round1((loadA / ratedA) * 100) : null,
      };
    });

  const consumers = devices.filter((d) => !NON_CONSUMERS.has(d.type));
  const totalLoadW = consumers.reduce((s, d) => s + (d.powerW ?? 0), 0);

  const unpowered = consumers
    .filter((d) => (d.powerW ?? 0) > 0 || ports.some((p) => p.assetId === d.id && p.kind === 'inlet'))
    .filter((d) => connectedInlets(d.id).length === 0)
    .map((d) => ({ id: d.id, name: d.name, powerW: d.powerW }));

  const singleFed = consumers
    .filter((d) => ports.filter((p) => p.assetId === d.id && p.kind === 'inlet').length >= 2)
    .map((d) => {
      const feeds = [
        ...new Set(
          connectedInlets(d.id)
            .map((i) => portById.get(connByInlet.get(i.id)!.outletPortId)?.feed)
            .filter((f): f is PowerFeed => Boolean(f)),
        ),
      ].sort();
      return { id: d.id, name: d.name, feeds };
    })
    .filter((d) => d.feeds.length < 2);

  return {
    rackId,
    maxPowerW,
    totalLoadW,
    btuHr: Math.round(totalLoadW * WATTS_TO_BTU_HR),
    headroomW: maxPowerW == null ? null : maxPowerW - totalLoadW,
    pdus,
    unpowered,
    singleFed,
  };
}
