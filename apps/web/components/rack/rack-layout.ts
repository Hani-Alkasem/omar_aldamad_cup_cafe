import { WATTS_TO_BTU_HR, type RackDevice, type RackFace } from '@itam/shared';

export interface PlacedDevice {
  device: RackDevice;
  /** Highest U the device occupies. */
  topU: number;
  /** 1-based CSS grid row (row 1 = top of the rack). */
  gridRow: number;
  span: number;
  /** Half-depth gear mounted on the other face: shown as a ghost behind this view. */
  ghost: boolean;
}

export interface FreeGap {
  fromU: number;
  toU: number;
  gridRow: number;
  span: number;
}

export interface RackLayout {
  heightU: number;
  face: RackFace;
  /** U numbers from top to bottom. */
  units: number[];
  placed: PlacedDevice[];
  zeroU: RackDevice[];
  gaps: FreeGap[];
  usedU: number;
  freeU: number;
  utilisationPct: number;
  powerW: number;
  btuHr: number;
}

/** Does this device physically occupy the given face? */
export function blocksFace(d: Pick<RackDevice, 'depth' | 'face'>, face: RackFace): boolean {
  if (d.depth === 'zero_u') return false;
  return d.depth === 'full' || d.face === face;
}

const gridRowFor = (heightU: number, topU: number) => heightU - topU + 1;

export function computeRackLayout(heightU: number, devices: RackDevice[], face: RackFace): RackLayout {
  const units = Array.from({ length: heightU }, (_, i) => heightU - i);
  const taken = new Array<boolean>(heightU + 2).fill(false);
  const placed: PlacedDevice[] = [];
  const zeroU: RackDevice[] = [];

  for (const device of devices) {
    if (device.depth === 'zero_u' || device.startU == null) {
      if (device.depth === 'zero_u') zeroU.push(device);
      continue;
    }
    const topU = Math.min(heightU, device.startU + device.sizeU - 1);
    const span = topU - device.startU + 1;
    const blocks = blocksFace(device, face);
    if (blocks) for (let u = device.startU; u <= topU; u++) taken[u] = true;
    placed.push({ device, topU, gridRow: gridRowFor(heightU, topU), span, ghost: !blocks });
  }

  // Free gaps on this face, top to bottom, merged into contiguous runs.
  const gaps: FreeGap[] = [];
  let runTop: number | null = null;
  for (let u = heightU; u >= 0; u--) {
    const free = u >= 1 && !taken[u];
    if (free && runTop === null) runTop = u;
    if (!free && runTop !== null) {
      const fromU = u + 1;
      gaps.push({ fromU, toU: runTop, gridRow: gridRowFor(heightU, runTop), span: runTop - fromU + 1 });
      runTop = null;
    }
  }

  const usedU = taken.filter(Boolean).length;
  const powerW = devices.reduce((sum, d) => sum + (d.powerW ?? 0), 0);
  return {
    heightU,
    face,
    units,
    placed: placed.sort((a, b) => Number(a.ghost) - Number(b.ghost) || b.topU - a.topU),
    zeroU,
    gaps,
    usedU,
    freeU: heightU - usedU,
    utilisationPct: heightU === 0 ? 0 : Math.round((usedU / heightU) * 1000) / 10,
    powerW,
    btuHr: Math.round(powerW * WATTS_TO_BTU_HR),
  };
}

/**
 * Would `device` fit with its bottom at `startU`? Mirrors the server's rule so drag previews
 * are honest; the server (and its EXCLUDE constraint) remains the authority.
 */
export function canPlace(heightU: number, devices: RackDevice[], device: RackDevice, startU: number): { ok: boolean; blockers: RackDevice[] } {
  if (startU < 1 || startU + device.sizeU - 1 > heightU) return { ok: false, blockers: [] };
  const top = startU + device.sizeU - 1;
  const faces: RackFace[] = device.depth === 'full' ? ['front', 'rear'] : device.face ? [device.face] : [];
  const blockers = devices.filter(
    (o) =>
      o.id !== device.id &&
      o.startU != null &&
      faces.some((f) => blocksFace(o, f)) &&
      o.startU <= top &&
      startU <= o.startU + o.sizeU - 1,
  );
  return { ok: blockers.length === 0, blockers };
}

/** Bottom U for a device dropped with its top edge on `targetTopU`, clamped into the rack. */
export function startForDrop(heightU: number, sizeU: number, targetTopU: number): number {
  return Math.max(1, Math.min(heightU - sizeU + 1, targetTopU - sizeU + 1));
}
