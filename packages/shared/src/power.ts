import { z } from 'zod';

const uuid = z.string().uuid();

export const PowerPortKind = z.enum(['inlet', 'outlet']);
export type PowerPortKind = z.infer<typeof PowerPortKind>;
export const PowerFeed = z.enum(['A', 'B', 'C']);
export type PowerFeed = z.infer<typeof PowerFeed>;

export const BulkPowerPortsSchema = z.object({
  kind: PowerPortKind,
  prefix: z.string().trim().min(1).max(32),
  count: z.number().int().min(1).max(96),
  feed: PowerFeed.optional(),
  voltage: z.number().int().min(1).max(1000).default(230),
  maxAmps: z.number().positive().max(1000).optional(),
});
export type BulkPowerPortsInput = z.infer<typeof BulkPowerPortsSchema>;

export const ConnectPowerSchema = z.object({ outletPortId: uuid, inletPortId: uuid });
export type ConnectPowerInput = z.infer<typeof ConnectPowerSchema>;

export interface PduLoad {
  pduId: string;
  pduName: string;
  feed: PowerFeed | null;
  outletsTotal: number;
  outletsUsed: number;
  loadW: number;
  /** Amps at the outlet voltage; null if voltage unknown. */
  loadA: number;
  ratedA: number | null;
  utilisationPct: number | null;
}

export interface RackPowerSummary {
  rackId: string;
  maxPowerW: number | null;
  totalLoadW: number;
  btuHr: number;
  headroomW: number | null;
  pdus: PduLoad[];
  /** Racked devices that draw power but have no connected inlet. */
  unpowered: Array<{ id: string; name: string; powerW: number | null }>;
  /** Devices with 2+ inlets fed from fewer than two distinct feeds. */
  singleFed: Array<{ id: string; name: string; feeds: string[] }>;
}
