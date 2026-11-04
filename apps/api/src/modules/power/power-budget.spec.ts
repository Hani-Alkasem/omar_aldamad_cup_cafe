import { computeRackPower, type BudgetPort } from './power-budget';

const outlet = (id: string, pdu: string, feed: 'A' | 'B'): BudgetPort => ({ id, assetId: pdu, kind: 'outlet', feed, voltage: 230, maxAmps: null });
const inlet = (id: string, asset: string, maxAmps: number | null = null): BudgetPort => ({ id, assetId: asset, kind: 'inlet', feed: null, voltage: 230, maxAmps });

describe('rack power budget', () => {
  const devices = [
    { id: 'pduA', name: 'pdu-a', type: 'pdu', powerW: null },
    { id: 'pduB', name: 'pdu-b', type: 'pdu', powerW: null },
    { id: 'srv1', name: 'srv-1', type: 'physical_server', powerW: 600 },
    { id: 'srv2', name: 'srv-2', type: 'physical_server', powerW: 460 },
    { id: 'sw', name: 'switch', type: 'switch', powerW: 200 },
  ];
  const ports = [
    inlet('pduA-in', 'pduA', 16), inlet('pduB-in', 'pduB', 16),
    outlet('a1', 'pduA', 'A'), outlet('a2', 'pduA', 'A'), outlet('a3', 'pduA', 'A'),
    outlet('b1', 'pduB', 'B'), outlet('b2', 'pduB', 'B'),
    inlet('srv1-psu1', 'srv1'), inlet('srv1-psu2', 'srv1'),
    inlet('srv2-psu1', 'srv2'), inlet('srv2-psu2', 'srv2'),
    inlet('sw-psu1', 'sw'),
  ];
  const conns = [
    { outletPortId: 'a1', inletPortId: 'srv1-psu1' },
    { outletPortId: 'b1', inletPortId: 'srv1-psu2' },
    { outletPortId: 'a2', inletPortId: 'srv2-psu1' },
    { outletPortId: 'a3', inletPortId: 'srv2-psu2' },
  ];

  const r = computeRackPower('rack', 3000, devices, ports, conns);

  it('splits draw across redundant supplies and sums per PDU', () => {
    const a = r.pdus.find((p) => p.pduId === 'pduA')!;
    const b = r.pdus.find((p) => p.pduId === 'pduB')!;
    expect(a).toMatchObject({ feed: 'A', outletsTotal: 3, outletsUsed: 3, loadW: 760, loadA: 3.3, ratedA: 16, utilisationPct: 20.6 });
    expect(b).toMatchObject({ feed: 'B', outletsTotal: 2, outletsUsed: 1, loadW: 300 });
  });

  it('reports totals, BTU and headroom', () => {
    expect(r).toMatchObject({ totalLoadW: 1260, btuHr: 4299, headroomW: 1740 });
  });

  it('flags unpowered devices and supplies on a single feed', () => {
    expect(r.unpowered.map((d) => d.id)).toEqual(['sw']);
    expect(r.singleFed).toEqual([{ id: 'srv2', name: 'srv-2', feeds: ['A'] }]);
  });
});
