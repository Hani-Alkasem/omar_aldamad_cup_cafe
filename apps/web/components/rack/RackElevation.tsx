'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import type { RackDevice, RackFace } from '@itam/shared';
import { DeviceCard } from './DeviceCard';
import { canPlace, computeRackLayout, startForDrop, type PlacedDevice } from './rack-layout';

export interface MoveResult {
  ok: boolean;
  message?: string;
}

export interface RackElevationProps {
  rack: { id: string; name: string; heightU: number; room?: string | null; row?: string | null };
  devices: RackDevice[];
  /** Persist a move. Resolve { ok: false } (e.g. on 409) to roll the optimistic update back. */
  onMove?: (deviceId: string, startU: number) => Promise<MoveResult>;
  onSelect?: (device: RackDevice) => void;
  initialFace?: RackFace;
}

/** One U in pixels. 42U ≈ 840px, a comfortable desktop height. */
const U_PX = 20;

const STATUS_STYLE: Record<RackDevice['status'], string> = {
  active: 'bg-emerald-600/90 border-emerald-400 text-white',
  maintenance: 'bg-amber-500/90 border-amber-300 text-amber-950',
  planned: 'bg-sky-900/60 border-sky-400 border-dashed text-sky-100',
  in_stock: 'bg-slate-600/90 border-slate-400 text-white',
  retired: 'bg-zinc-700/80 border-zinc-500 text-zinc-200',
  disposed: 'bg-zinc-800/80 border-zinc-600 text-zinc-400',
};

const TYPE_STYLE: Partial<Record<RackDevice['type'], string>> = {
  switch: 'bg-indigo-600/90 border-indigo-400 text-white',
  router: 'bg-indigo-600/90 border-indigo-400 text-white',
  firewall: 'bg-rose-700/90 border-rose-400 text-white',
  storage_array: 'bg-violet-700/90 border-violet-400 text-white',
  patch_panel: 'bg-slate-500/90 border-slate-300 text-white',
};

function deviceClasses(d: RackDevice): string {
  // Status wins when it needs attention; otherwise colour by device type.
  if (d.status !== 'active') return STATUS_STYLE[d.status];
  return TYPE_STYLE[d.type] ?? STATUS_STYLE.active;
}

export function RackElevation({ rack, devices: initialDevices, onMove, onSelect, initialFace = 'front' }: RackElevationProps) {
  const [face, setFace] = useState<RackFace>(initialFace);
  const [devices, setDevices] = useState(initialDevices);
  const [hovered, setHovered] = useState<string | null>(null);
  const [dragging, setDragging] = useState<RackDevice | null>(null);
  const [dropTopU, setDropTopU] = useState<number | null>(null);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());

  const layout = useMemo(() => computeRackLayout(rack.heightU, devices, face), [rack.heightU, devices, face]);
  const movable = Boolean(onMove);

  const preview = useMemo(() => {
    if (!dragging || dropTopU == null) return null;
    const startU = startForDrop(rack.heightU, dragging.sizeU, dropTopU);
    return { startU, ...canPlace(rack.heightU, devices, dragging, startU) };
  }, [dragging, dropTopU, devices, rack.heightU]);

  const move = useCallback(
    async (device: RackDevice, startU: number) => {
      if (!onMove || startU === device.startU) return;
      const check = canPlace(rack.heightU, devices, device, startU);
      if (!check.ok) {
        setStatus({ tone: 'error', text: check.blockers.length ? `U${startU} is taken by ${check.blockers.map((b) => b.name).join(', ')}` : 'That position is outside the rack' });
        return;
      }
      const previous = devices;
      setDevices((ds) => ds.map((d) => (d.id === device.id ? { ...d, startU } : d)));
      setStatus({ tone: 'ok', text: `Moving ${device.name} to U${startU}…` });
      const result = await onMove(device.id, startU);
      if (result.ok) {
        setStatus({ tone: 'ok', text: `${device.name} moved to U${startU}` });
      } else {
        setDevices(previous);
        setStatus({ tone: 'error', text: result.message ?? `Could not move ${device.name}; it is back where it was` });
      }
    },
    [devices, onMove, rack.heightU],
  );

  const focusSibling = (current: PlacedDevice, dir: 1 | -1) => {
    const visible = layout.placed.filter((p) => !p.ghost).sort((a, b) => b.topU - a.topU);
    const i = visible.findIndex((p) => p.device.id === current.device.id);
    const next = visible[i + dir];
    if (next) buttons.current.get(next.device.id)?.focus();
  };

  const onDeviceKey = (e: React.KeyboardEvent, p: PlacedDevice) => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (e.altKey && movable) {
        // Keyboard alternative to drag: Alt+Arrow moves the device by one U.
        void move(p.device, (p.device.startU ?? 1) + (e.key === 'ArrowUp' ? 1 : -1));
      } else {
        focusSibling(p, e.key === 'ArrowUp' ? -1 : 1);
      }
    }
    if (e.key === 'Escape') setHovered(null);
  };

  const unitFromPointer = (e: React.DragEvent<HTMLElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const row = Math.floor((e.clientY - rect.top) / U_PX);
    return Math.max(1, Math.min(rack.heightU, rack.heightU - row));
  };

  const gutter = (side: 'start' | 'end') => (
    <ol aria-hidden className={`grid font-mono text-[10px] leading-none text-slate-500 ${side === 'start' ? 'text-end pe-1.5' : 'ps-1.5'}`} style={{ gridTemplateRows: `repeat(${rack.heightU}, ${U_PX}px)` }}>
      {layout.units.map((u) => (
        <li key={u} className="flex items-center justify-end">
          {u}
        </li>
      ))}
    </ol>
  );

  return (
    <section aria-labelledby={`rack-${rack.id}-title`} className="inline-flex max-w-full flex-col gap-3 text-slate-200">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id={`rack-${rack.id}-title`} className="text-lg font-semibold text-white">
            {rack.name} <span className="font-normal text-slate-400">· {rack.heightU}U</span>
          </h2>
          {(rack.room || rack.row) && <p className="text-xs text-slate-400">{[rack.room, rack.row].filter(Boolean).join(' / ')}</p>}
        </div>
        <div role="radiogroup" aria-label="Rack face" className="inline-flex rounded-md border border-slate-700 bg-slate-900 p-0.5 text-sm">
          {(['front', 'rear'] as const).map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={face === f}
              onClick={() => setFace(f)}
              className={`min-h-9 rounded px-3 capitalize transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 ${face === f ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {f}
            </button>
          ))}
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {[
          ['Used', `${layout.usedU}U`],
          ['Free', `${layout.freeU}U`],
          ['Utilisation', `${layout.utilisationPct}%`],
          ['Load', layout.powerW ? `${(layout.powerW / 1000).toFixed(2)} kW · ${layout.btuHr.toLocaleString()} BTU/h` : '—'],
        ].map(([k, v]) => (
          <div key={k} className="rounded-md border border-slate-800 bg-slate-900 px-2 py-1.5">
            <dt className="text-slate-500">{k}</dt>
            <dd className="font-medium text-slate-100">{v}</dd>
          </div>
        ))}
      </dl>

      <div className="flex items-stretch rounded-lg border-4 border-slate-700 bg-slate-950 p-1.5 shadow-inner">
        {gutter('start')}
        <div className="flex gap-1">
          {layout.zeroU.length > 0 && (
            <ul aria-label="Zero-U devices" className="flex w-4 flex-col gap-1">
              {layout.zeroU.map((d) => (
                <li key={d.id} title={`${d.name} (zero-U)`} className="flex-1 rounded-sm border border-amber-500/60 bg-amber-900/50" />
              ))}
            </ul>
          )}
          <div
            role="list"
            aria-label={`${rack.name} ${face} elevation`}
            className="relative grid w-[min(22rem,calc(100vw-8rem))] rounded-sm bg-[repeating-linear-gradient(to_bottom,transparent_0,transparent_19px,rgb(30_41_59)_19px,rgb(30_41_59)_20px)]"
            style={{ gridTemplateRows: `repeat(${rack.heightU}, ${U_PX}px)` }}
            onDragOver={(e) => {
              if (!dragging) return;
              e.preventDefault();
              setDropTopU(unitFromPointer(e) + Math.floor(dragging.sizeU / 2));
            }}
            onDragLeave={() => setDropTopU(null)}
            onDrop={(e) => {
              e.preventDefault();
              if (dragging && preview) void move(dragging, preview.startU);
              setDragging(null);
              setDropTopU(null);
            }}
          >
            {layout.gaps.map((g) => (
              <div
                key={`gap-${g.fromU}`}
                aria-hidden
                className="col-start-1 flex items-center justify-center text-[10px] text-slate-600"
                style={{ gridRow: `${g.gridRow} / span ${g.span}` }}
              >
                {g.span >= 2 ? `${g.span}U free` : ''}
              </div>
            ))}

            {layout.placed.map((p) => {
              const d = p.device;
              const cardId = `card-${d.id}`;
              if (p.ghost) {
                return (
                  <div
                    key={`ghost-${d.id}`}
                    aria-hidden
                    title={`${d.name} (${d.face}, half depth)`}
                    className="col-start-1 mx-0.5 my-px rounded-sm border border-dashed border-slate-600 bg-slate-800/40"
                    style={{ gridRow: `${p.gridRow} / span ${p.span}` }}
                  />
                );
              }
              const isDragging = dragging?.id === d.id;
              return (
                <div key={d.id} role="listitem" className="relative col-start-1 mx-0.5 my-px" style={{ gridRow: `${p.gridRow} / span ${p.span}` }}>
                  <button
                    ref={(el) => {
                      if (el) buttons.current.set(d.id, el);
                      else buttons.current.delete(d.id);
                    }}
                    type="button"
                    draggable={movable}
                    aria-describedby={hovered === d.id ? cardId : undefined}
                    aria-label={`${d.name}, U${d.startU}${p.span > 1 ? `–U${p.topU}` : ''}, ${d.status}`}
                    onMouseEnter={() => setHovered(d.id)}
                    onMouseLeave={() => setHovered(null)}
                    onFocus={() => setHovered(d.id)}
                    onBlur={() => setHovered(null)}
                    onKeyDown={(e) => onDeviceKey(e, p)}
                    onClick={() => onSelect?.(d)}
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', d.id);
                      setDragging(d);
                      setHovered(null);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setDropTopU(null);
                    }}
                    className={`flex h-full w-full items-center justify-between gap-2 overflow-hidden rounded-sm border px-2 text-start text-xs shadow-sm transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-300 ${deviceClasses(d)} ${movable ? 'cursor-grab active:cursor-grabbing' : ''} ${isDragging ? 'opacity-40' : 'hover:brightness-110'}`}
                  >
                    <span className="truncate font-medium">{d.name}</span>
                    <span className="shrink-0 font-mono text-[10px] opacity-80">
                      {d.depth === 'half' ? '½ ' : ''}
                      {p.span}U
                    </span>
                  </button>
                  {hovered === d.id && !dragging && (
                    <div className="absolute start-full top-0 z-20 ms-3">
                      <DeviceCard device={d} id={cardId} />
                    </div>
                  )}
                </div>
              );
            })}

            {preview && dragging && (
              <div
                aria-hidden
                className={`pointer-events-none col-start-1 z-10 rounded-sm border-2 ${preview.ok ? 'border-emerald-300 bg-emerald-400/20' : 'border-rose-400 bg-rose-500/25'}`}
                style={{ gridRow: `${rack.heightU - (preview.startU + dragging.sizeU - 1) + 1} / span ${dragging.sizeU}` }}
              />
            )}
          </div>
        </div>
        {gutter('end')}
      </div>

      <p role="status" aria-live="polite" className={`min-h-5 text-sm ${status?.tone === 'error' ? 'text-rose-400' : 'text-slate-400'}`}>
        {status?.text ?? (movable ? 'Drag a device to move it, or focus it and press Alt+↑/↓.' : '')}
      </p>
    </section>
  );
}
