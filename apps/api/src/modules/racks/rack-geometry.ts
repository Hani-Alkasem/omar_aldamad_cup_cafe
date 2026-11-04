import type { MountDepth, RackFace } from '@itam/shared';

/** Inclusive U span, 1 = bottom of the rack. */
export interface USpan {
  fromU: number;
  toU: number;
}

export const FACES: readonly RackFace[] = ['front', 'rear'];

/** Faces a device physically blocks: full-depth blocks both, half-depth one, zero-U none. */
export function facesBlocked(depth: MountDepth, face: RackFace | null | undefined): RackFace[] {
  if (depth === 'zero_u') return [];
  if (depth === 'full') return [...FACES];
  return face ? [face] : [];
}

export const spanOf = (startU: number, sizeU: number): USpan => ({ fromU: startU, toU: startU + sizeU - 1 });

export const overlaps = (a: USpan, b: USpan) => a.fromU <= b.toU && b.fromU <= a.toU;

/** Contiguous free spans of a rack face given the occupied spans on it. */
export function freeSpans(heightU: number, occupied: USpan[]): USpan[] {
  const taken = new Array<boolean>(heightU + 1).fill(false);
  for (const s of occupied) for (let u = Math.max(1, s.fromU); u <= Math.min(heightU, s.toU); u++) taken[u] = true;
  const out: USpan[] = [];
  let start: number | null = null;
  for (let u = 1; u <= heightU + 1; u++) {
    const free = u <= heightU && !taken[u];
    if (free && start === null) start = u;
    if (!free && start !== null) {
      out.push({ fromU: start, toU: u - 1 });
      start = null;
    }
  }
  return out;
}

/**
 * Every start U where a device of sizeU fits on all the given faces.
 * `occupiedByFace` holds the spans already taken on each face.
 */
export function placeableStarts(heightU: number, sizeU: number, faces: RackFace[], occupiedByFace: Record<RackFace, USpan[]>): number[] {
  const starts: number[] = [];
  for (let start = 1; start + sizeU - 1 <= heightU; start++) {
    const span = spanOf(start, sizeU);
    if (faces.every((f) => !occupiedByFace[f].some((o) => overlaps(o, span)))) starts.push(start);
  }
  return starts;
}
