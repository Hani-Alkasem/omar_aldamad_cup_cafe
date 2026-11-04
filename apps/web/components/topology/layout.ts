import dagre from '@dagrejs/dagre';
import type { Graph } from '@itam/shared';

export const NODE_W = 184;
export const NODE_H = 56;

/**
 * Layered left-to-right layout: a dependency points right, so consumers sit left of what they
 * need. Pure and deterministic (same graph → same positions), which keeps re-renders stable.
 */
export function layoutGraph(graph: Graph): Map<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 28, ranksep: 90, marginx: 16, marginy: 16 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id))) g.setNode(n.id, { width: NODE_W, height: NODE_H });
  for (const e of [...graph.edges].sort((a, b) => a.id.localeCompare(b.id))) if (g.hasNode(e.source) && g.hasNode(e.target)) g.setEdge(e.source, e.target);
  dagre.layout(g);
  const out = new Map<string, { x: number; y: number }>();
  for (const id of g.nodes()) {
    const p = g.node(id);
    out.set(id, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  }
  return out;
}

/** ":5432, :6379" — what the arrow means at a glance. */
export const portLabel = (ports: number[]) => (ports.length ? ports.slice(0, 4).map((p) => `:${p}`).join(' ') + (ports.length > 4 ? ` +${ports.length - 4}` : '') : '');
