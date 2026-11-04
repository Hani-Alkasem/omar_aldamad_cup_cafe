'use client';

import type { RackElevation as Elevation } from '@itam/shared';
import { RackElevation, type MoveResult } from './RackElevation';

/** Wires the elevation to the API through the same-origin proxy. */
export function RackView({ elevation }: { elevation: Elevation }) {
  const onMove = async (deviceId: string, startU: number): Promise<MoveResult> => {
    try {
      const res = await fetch(`/api/assets/${deviceId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ startU }),
      });
      if (res.ok) return { ok: true };
      const body = await res.json().catch(() => ({}));
      return { ok: false, message: body.message ?? `Move failed (${res.status})` };
    } catch {
      return { ok: false, message: 'Network error; the device was put back' };
    }
  };
  return <RackElevation rack={elevation.rack} devices={elevation.devices} onMove={onMove} />;
}
