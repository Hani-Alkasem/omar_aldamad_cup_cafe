import { tracePath, type TraceCable, type TracePort } from './trace';

function source(ports: TracePort[], cables: TraceCable[]) {
  const byId = new Map(ports.map((p) => [p.id, p]));
  return {
    port: async (id: string) => byId.get(id),
    cableAt: async (id: string) => cables.find((c) => c.aPortId === id || c.bPortId === id),
  };
}
const port = (id: string, assetName: string, kind: TracePort['kind'] = 'ethernet', passThroughPortId: string | null = null): TracePort => ({
  id, portName: id, kind, assetId: assetName, assetName, passThroughPortId,
});
const cable = (id: string, a: string, b: string): TraceCable => ({ id, aPortId: a, bPortId: b, media: 'cat6', label: id });

describe('cable path trace', () => {
  it('follows server → patch front → rear → switch', async () => {
    const ports = [port('srv-eth0', 'srv'), port('pp-f1', 'pp', 'patch_front', 'pp-r1'), port('pp-r1', 'pp', 'patch_rear', 'pp-f1'), port('sw-1', 'sw')];
    const res = await tracePath('srv-eth0', source(ports, [cable('c1', 'srv-eth0', 'pp-f1'), cable('c2', 'pp-r1', 'sw-1')]));
    expect(res?.complete).toBe(true);
    expect(res?.endReason).toBe('endpoint');
    expect(res?.hops.map((h) => [h.portId, h.via.type])).toEqual([
      ['srv-eth0', 'start'],
      ['pp-f1', 'cable'],
      ['pp-r1', 'pass_through'],
      ['sw-1', 'cable'],
    ]);
  });

  it('stops at an uncabled patch rear port', async () => {
    const ports = [port('a', 'srv'), port('f', 'pp', 'patch_front', 'r'), port('r', 'pp', 'patch_rear', 'f')];
    const res = await tracePath('a', source(ports, [cable('c1', 'a', 'f')]));
    expect(res).toMatchObject({ complete: false, endReason: 'uncabled' });
    expect(res?.hops).toHaveLength(3);
  });

  it('detects loops', async () => {
    const ports = [port('f1', 'pp', 'patch_front', 'r1'), port('r1', 'pp', 'patch_rear', 'f1'), port('f2', 'pp2', 'patch_front', 'r2'), port('r2', 'pp2', 'patch_rear', 'f2')];
    const res = await tracePath('f1', source(ports, [cable('c1', 'f1', 'f2'), cable('c2', 'r2', 'r1')]));
    expect(res?.endReason).toBe('loop');
  });

  it('returns undefined for an unknown port and uncabled for a bare one', async () => {
    expect(await tracePath('x', source([], []))).toBeUndefined();
    expect(await tracePath('a', source([port('a', 'srv')], []))).toMatchObject({ endReason: 'uncabled', hops: [{ portId: 'a' }] });
  });
});
