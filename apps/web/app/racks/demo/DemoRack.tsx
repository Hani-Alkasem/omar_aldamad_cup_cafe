'use client';

import type { RackDevice } from '@itam/shared';
import { RackElevation } from '@/components/rack/RackElevation';

/** Simulates the API: a short delay, then success (the component already refuses collisions). */
export function DemoRack({ rack, devices }: { rack: { id: string; name: string; heightU: number; room: string; row: string }; devices: RackDevice[] }) {
  const onMove = async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true };
  };
  return <RackElevation rack={rack} devices={devices} onMove={onMove} />;
}
