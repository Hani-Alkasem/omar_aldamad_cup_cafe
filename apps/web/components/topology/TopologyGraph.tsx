'use client';

import '@xyflow/react/dist/style.css';
import type { Graph, GraphEdge, GraphNode } from '@itam/shared';
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';
import { layoutGraph, NODE_H, NODE_W, portLabel } from './layout';

type AssetNodeData = GraphNode & Record<string, unknown>;

const STATUS_DOT: Record<string, string> = { active: 'bg-emerald-400', maintenance: 'bg-amber-400', planned: 'bg-slate-400', in_stock: 'bg-slate-400', retired: 'bg-slate-600', disposed: 'bg-slate-600' };
const ORIGIN_COLOR: Record<GraphEdge['origin'], string> = { discovery: '#38bdf8', manual: '#a78bfa', power: '#f59e0b' };
const typeLabel = (t: string) => t.replace(/_/g, ' ').replace(/\bpdu\b/, 'PDU').replace(/\bups\b/, 'UPS');

function AssetNode({ data, selected }: NodeProps<Node<AssetNodeData>>) {
  return (
    <div
      style={{ width: NODE_W, height: NODE_H }}
      className={`flex flex-col justify-center rounded-md border bg-slate-900 px-3 text-left shadow ${
        data.isRoot ? 'border-sky-400 ring-2 ring-sky-400/40' : selected ? 'border-slate-300' : 'border-slate-700'
      }`}
    >
      <Handle type="target" position={Position.Left} className="!h-1.5 !w-1.5 !border-0 !bg-slate-500" />
      <p className="flex items-center gap-1.5 truncate text-sm font-medium text-white">
        <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[data.status] ?? 'bg-slate-400'}`} aria-hidden />
        <span className="truncate">{data.name}</span>
      </p>
      <p className="truncate text-[11px] capitalize text-slate-400">
        {typeLabel(data.type)}
        {data.applications.length ? ` · ${data.applications.join(', ')}` : ''}
      </p>
      <Handle type="source" position={Position.Right} className="!h-1.5 !w-1.5 !border-0 !bg-slate-500" />
    </div>
  );
}

const nodeTypes = { asset: AssetNode };

/**
 * Interactive dependency map. Arrows point from a consumer to what it depends on; colour says
 * where the edge came from (discovery, a person, a power cord), dashes mark stale dependencies.
 */
export function TopologyGraph({ graph, height = 560 }: { graph: Graph; height?: number }) {
  const [selected, setSelected] = useState<{ kind: 'node'; node: GraphNode } | { kind: 'edge'; edge: GraphEdge } | null>(null);
  const byId = useMemo(() => new Map(graph.nodes.map((n) => [n.id, n])), [graph]);

  // Stable callbacks, and no state change when nothing changed: React Flow re-fires selection
  // handlers when their identity changes, which otherwise loops (React error #185).
  const selectNode = useCallback(
    (id: string | undefined) => {
      const node = id ? byId.get(id) : undefined;
      if (!node) return;
      setSelected((cur) => (cur?.kind === 'node' && cur.node.id === id ? cur : { kind: 'node', node }));
    },
    [byId],
  );
  // Layout is fixed, so the only node change we act on is selection (mouse or Enter/Space on a focused node).
  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const sel = changes.find((c): c is Extract<NodeChange, { type: 'select' }> => c.type === 'select' && c.selected);
      if (sel) selectNode(sel.id);
    },
    [selectNode],
  );
  const onNodeClick = useCallback((_: unknown, n: Node) => selectNode(n.id), [selectNode]);
  const onEdgeClick = useCallback(
    (_: unknown, e: Edge) => {
      const edge = graph.edges.find((x) => x.id === e.id);
      if (edge) setSelected((cur) => (cur?.kind === 'edge' && cur.edge.id === e.id ? cur : { kind: 'edge', edge }));
    },
    [graph],
  );
  const onPaneClick = useCallback(() => setSelected(null), []);

  const { nodes, edges } = useMemo(() => {
    const pos = layoutGraph(graph);
    const nodes: Node<AssetNodeData>[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'asset',
      position: pos.get(n.id) ?? { x: 0, y: 0 },
      data: n as AssetNodeData,
      ariaLabel: `${n.name}, ${typeLabel(n.type)}${n.isRoot ? ', selected root' : ''}`,
    }));
    const edges: Edge[] = graph.edges
      .filter((e) => byId.has(e.source) && byId.has(e.target))
      .map((e) => {
        const color = e.stale ? '#64748b' : ORIGIN_COLOR[e.origin];
        return {
          id: e.id,
          source: e.source,
          target: e.target,
          label: e.type === 'powered_by' ? 'power' : portLabel(e.ports) || undefined,
          labelStyle: { fill: '#cbd5e1', fontSize: 11 },
          labelBgStyle: { fill: '#0f172a' },
          labelBgPadding: [4, 2] as [number, number],
          style: { stroke: color, strokeWidth: 1.5, strokeDasharray: e.stale ? '5 4' : undefined },
          markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
          ariaLabel: `${byId.get(e.source)?.name} ${e.type.replace('_', ' ')} ${byId.get(e.target)?.name}`,
        };
      });
    return { nodes, edges };
  }, [graph, byId]);

  if (!graph.nodes.length) return null;

  return (
    <div className="space-y-3">
      {/* Shorter on phones, where a tall empty canvas pushes the details panel off screen. */}
      <div className="h-[min(var(--topo-h),70vh)] overflow-hidden rounded-lg border border-slate-800 bg-slate-950 sm:h-[var(--topo-h)]" style={{ ['--topo-h' as string]: `${height}px` }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="dark"
          fitView
          // Small graphs would otherwise be blown up to fill the canvas.
          fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={onNodeClick}
          onEdgeClick={onEdgeClick}
          onNodesChange={onNodesChange}
          onPaneClick={onPaneClick}
        >
          <Background color="#1e293b" gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-400" aria-label="Legend">
        <span><span className="mr-1 inline-block h-0.5 w-5 align-middle" style={{ background: ORIGIN_COLOR.discovery }} />discovered</span>
        <span><span className="mr-1 inline-block h-0.5 w-5 align-middle" style={{ background: ORIGIN_COLOR.manual }} />added by a person</span>
        <span><span className="mr-1 inline-block h-0.5 w-5 align-middle" style={{ background: ORIGIN_COLOR.power }} />power</span>
        <span><span className="mr-1 inline-block w-5 border-t border-dashed border-slate-500 align-middle" />not seen for 14+ days</span>
        <span>Arrow points to what is depended on.</span>
      </div>

      {selected && (
        <aside className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm" aria-live="polite">
          {selected.kind === 'node' ? (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="font-medium text-white">{selected.node.name}</p>
                <p className="text-xs capitalize text-slate-400">{typeLabel(selected.node.type)} · {selected.node.status}</p>
                {selected.node.applications.length > 0 && <p className="text-xs text-slate-400">Part of {selected.node.applications.join(', ')}</p>}
                <p className="mt-1 text-xs text-slate-400">
                  Depends on {graph.edges.filter((e) => e.source === selected.node.id).length} · used by {graph.edges.filter((e) => e.target === selected.node.id).length} (in this view)
                </p>
              </div>
              <div className="flex gap-3 text-sm">
                <Link className="text-sky-400 hover:underline" href={`/assets/${selected.node.id}`}>Open asset</Link>
                {!selected.node.isRoot && <Link className="text-sky-400 hover:underline" href={`/topology?root=${selected.node.id}`}>Centre map here</Link>}
              </div>
            </div>
          ) : (
            <div className="space-y-1">
              <p className="font-medium text-white">
                {byId.get(selected.edge.source)?.name} <span className="text-slate-400">{selected.edge.type.replace('_', ' ')}</span> {byId.get(selected.edge.target)?.name}
              </p>
              <p className="text-xs text-slate-400">
                {selected.edge.ports.length ? `Ports ${selected.edge.ports.join(', ')}` : 'No ports recorded'}
                {selected.edge.process ? ` · process ${selected.edge.process}` : ''}
                {' · '}
                {selected.edge.origin === 'discovery' ? `seen ${selected.edge.observations}× · last ${selected.edge.lastSeenAt.slice(0, 10)}${selected.edge.stale ? ' (stale)' : ''}` : selected.edge.origin === 'manual' ? 'added by a person' : 'from a power cord'}
              </p>
            </div>
          )}
        </aside>
      )}
    </div>
  );
}
