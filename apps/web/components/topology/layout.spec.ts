import { describe, expect, it } from 'vitest';
import type { Graph } from '@itam/shared';
import { layoutGraph, portLabel } from './layout';

const node = (id: string) => ({ id, name: id, type: 'physical_server', status: 'active', applications: [], isRoot: false });
const edge = (id: string, source: string, target: string) => ({ id, source, target, type: 'depends_on', origin: 'discovery' as const, ports: [], process: null, lastSeenAt: '', observations: 1, stale: false });

describe('layoutGraph', () => {
  const g: Graph = { nodes: [node('web'), node('db'), node('cache')], edges: [edge('e1', 'web', 'db'), edge('e2', 'web', 'cache')], truncated: false };

  it('puts consumers left of their dependencies', () => {
    const p = layoutGraph(g);
    expect(p.get('web')!.x).toBeLessThan(p.get('db')!.x);
    expect(p.get('db')!.x).toBe(p.get('cache')!.x);
    expect(p.get('db')!.y).not.toBe(p.get('cache')!.y);
  });

  it('is deterministic regardless of input order', () => {
    const shuffled: Graph = { ...g, nodes: [...g.nodes].reverse(), edges: [...g.edges].reverse() };
    expect([...layoutGraph(shuffled)].sort()).toEqual([...layoutGraph(g)].sort());
  });

  it('ignores edges to nodes outside the graph (truncated results)', () => {
    expect(() => layoutGraph({ ...g, edges: [...g.edges, edge('e3', 'web', 'ghost')] })).not.toThrow();
  });
});

describe('portLabel', () => {
  it('summarises long port lists', () => {
    expect(portLabel([5432])).toBe(':5432');
    expect(portLabel([1, 2, 3, 4, 5, 6])).toBe(':1 :2 :3 :4 +2');
    expect(portLabel([])).toBe('');
  });
});
