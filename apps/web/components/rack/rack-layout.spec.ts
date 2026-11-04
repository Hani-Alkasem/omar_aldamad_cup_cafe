import { describe, expect, it } from 'vitest';
import type { RackDevice } from '@itam/shared';
import { blocksFace, canPlace, computeRackLayout, startForDrop } from './rack-layout';

const dev = (id: string, startU: number | null, sizeU: number, extra: Partial<RackDevice> = {}): RackDevice => ({
  id,
  name: id,
  type: 'physical_server',
  status: 'active',
  model: null,
  startU,
  sizeU,
  face: 'front',
  depth: 'full',
  powerW: 0,
  ...extra,
});

describe('computeRackLayout', () => {
  const devices = [
    dev('top-switch', 42, 1, { powerW: 300 }),
    dev('server', 10, 2, { powerW: 700 }),
    dev('rear-panel', 20, 1, { face: 'rear', depth: 'half' }),
    dev('pdu', null, 1, { depth: 'zero_u', type: 'pdu', face: null }),
  ];

  it('orders units top-down and maps devices to grid rows', () => {
    const l = computeRackLayout(42, devices, 'front');
    expect(l.units[0]).toBe(42);
    expect(l.units.at(-1)).toBe(1);
    const server = l.placed.find((p) => p.device.id === 'server')!;
    expect(server).toMatchObject({ topU: 11, gridRow: 32, span: 2, ghost: false });
    expect(l.placed.find((p) => p.device.id === 'top-switch')!.gridRow).toBe(1);
  });

  it('shows other-face half-depth gear as a ghost that does not use space', () => {
    const front = computeRackLayout(42, devices, 'front');
    expect(front.placed.find((p) => p.device.id === 'rear-panel')!.ghost).toBe(true);
    expect(front.usedU).toBe(3);
    const rear = computeRackLayout(42, devices, 'rear');
    expect(rear.placed.find((p) => p.device.id === 'rear-panel')!.ghost).toBe(false);
    expect(rear.usedU).toBe(4);
  });

  it('computes free gaps, utilisation, power and BTU', () => {
    const l = computeRackLayout(42, devices, 'front');
    expect(l.gaps.map((g) => [g.fromU, g.toU])).toEqual([[12, 41], [1, 9]]);
    expect(l.gaps[0]).toMatchObject({ gridRow: 2, span: 30 });
    expect(l.freeU).toBe(39);
    expect(l.utilisationPct).toBe(7.1);
    expect(l.powerW).toBe(1000);
    expect(l.btuHr).toBe(3412);
    expect(l.zeroU.map((d) => d.id)).toEqual(['pdu']);
  });

  it('an empty rack is one gap', () => {
    const l = computeRackLayout(12, [], 'rear');
    expect(l.gaps).toEqual([{ fromU: 1, toU: 12, gridRow: 1, span: 12 }]);
    expect(l.utilisationPct).toBe(0);
  });
});

describe('placement helpers', () => {
  const rack = [dev('a', 10, 2), dev('half-rear', 20, 1, { face: 'rear', depth: 'half' })];

  it('blocksFace follows mount depth', () => {
    expect(blocksFace({ depth: 'full', face: 'front' }, 'rear')).toBe(true);
    expect(blocksFace({ depth: 'half', face: 'front' }, 'rear')).toBe(false);
    expect(blocksFace({ depth: 'zero_u', face: null }, 'front')).toBe(false);
  });

  it('canPlace rejects overlaps, out-of-range, and ignores the device itself', () => {
    const mover = dev('mover', 1, 2);
    expect(canPlace(42, rack, mover, 11)).toMatchObject({ ok: false });
    expect(canPlace(42, rack, mover, 41).ok).toBe(true);
    expect(canPlace(42, rack, mover, 42).ok).toBe(false);
    expect(canPlace(42, rack, rack[0], 11).ok).toBe(true);
  });

  it('half-depth front gear fits where only rear half-depth gear sits', () => {
    expect(canPlace(42, rack, dev('half-front', 1, 1, { depth: 'half' }), 20).ok).toBe(true);
    expect(canPlace(42, rack, dev('full', 1, 1), 20).ok).toBe(false);
  });

  it('startForDrop aligns the top edge and clamps', () => {
    expect(startForDrop(42, 2, 30)).toBe(29);
    expect(startForDrop(42, 4, 2)).toBe(1);
    expect(startForDrop(42, 2, 42)).toBe(41);
  });
});
