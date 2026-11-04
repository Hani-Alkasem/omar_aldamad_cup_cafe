import type { AssetStatus, AssetType, MountDepth, RackFace } from './enums';

export interface RackDevice {
  id: string;
  name: string;
  type: AssetType;
  status: AssetStatus;
  model: string | null;
  /** Lowest U the device occupies (1 = bottom). Null for zero-U. */
  startU: number | null;
  sizeU: number;
  face: RackFace | null;
  depth: MountDepth;
  powerW?: number | null;
  tempC?: number | null;
  ports?: number | null;
}

export interface RackElevation {
  rack: { id: string; name: string; heightU: number; row?: string | null; room?: string | null };
  devices: RackDevice[];
  free: Record<RackFace, Array<{ fromU: number; toU: number }>>;
}

/** Thermal output of a load: 1 W = 3.412 BTU/h. */
export const WATTS_TO_BTU_HR = 3.412;
