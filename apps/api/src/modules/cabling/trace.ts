import type { CableMedia, PortKind, TraceHop, TraceResult } from '@itam/shared';

export interface TracePort {
  id: string;
  portName: string;
  kind: PortKind;
  assetId: string;
  assetName: string;
  passThroughPortId: string | null;
}

export interface TraceCable {
  id: string;
  aPortId: string;
  bPortId: string;
  media: CableMedia;
  label: string | null;
}

export interface TraceSource {
  port(id: string): Promise<TracePort | undefined>;
  cableAt(portId: string): Promise<TraceCable | undefined>;
}

export const MAX_HOPS = 64;

const hop = (p: TracePort, via: TraceHop['via']): TraceHop => ({ portId: p.id, portName: p.portName, kind: p.kind, assetId: p.assetId, assetName: p.assetName, via });

/**
 * Follow a physical path from a port: cable → far port → (patch-panel pass-through → cable)…
 * until it reaches a non-patch endpoint, an uncabled port, a loop, or the hop guard.
 */
export async function tracePath(startId: string, src: TraceSource): Promise<TraceResult | undefined> {
  const start = await src.port(startId);
  if (!start) return undefined;
  const hops: TraceHop[] = [hop(start, { type: 'start' })];
  const seen = new Set([start.id]);
  let current = start;

  while (hops.length < MAX_HOPS) {
    const cable = await src.cableAt(current.id);
    if (!cable) return { hops, complete: false, endReason: 'uncabled' };

    const farId = cable.aPortId === current.id ? cable.bPortId : cable.aPortId;
    if (seen.has(farId)) return { hops, complete: false, endReason: 'loop' };
    const far = await src.port(farId);
    if (!far) return { hops, complete: false, endReason: 'uncabled' };
    seen.add(far.id);
    hops.push(hop(far, { type: 'cable', cableId: cable.id, media: cable.media, label: cable.label }));

    if (!far.passThroughPortId) return { hops, complete: true, endReason: 'endpoint' };
    if (seen.has(far.passThroughPortId)) return { hops, complete: false, endReason: 'loop' };
    const peer = await src.port(far.passThroughPortId);
    if (!peer) return { hops, complete: false, endReason: 'uncabled' };
    seen.add(peer.id);
    hops.push(hop(peer, { type: 'pass_through' }));
    current = peer;
  }
  return { hops, complete: false, endReason: 'max_hops' };
}
