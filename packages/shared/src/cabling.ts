import { z } from 'zod';

const uuid = z.string().uuid();

export const PortKind = z.enum(['ethernet', 'sfp', 'qsfp', 'console', 'management', 'patch_front', 'patch_rear']);
export type PortKind = z.infer<typeof PortKind>;
export const CableMedia = z.enum(['cat5e', 'cat6', 'cat6a', 'fiber_om3', 'fiber_om4', 'fiber_os2', 'dac', 'aoc', 'power']);
export type CableMedia = z.infer<typeof CableMedia>;

const mac = z
  .string()
  .trim()
  .regex(/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i, 'MAC address like 00:1a:2b:3c:4d:5e')
  .transform((m) => m.toLowerCase().replace(/-/g, ':'));

export const CreatePortSchema = z.object({
  portName: z.string().trim().min(1).max(64),
  kind: PortKind.default('ethernet'),
  position: z.number().int().min(1).max(10000).optional(),
  macAddress: mac.optional(),
  speedMbps: z.number().int().positive().max(1_600_000).optional(),
  vlanId: uuid.nullable().optional(),
  isUplink: z.boolean().default(false),
});
export type CreatePortInput = z.infer<typeof CreatePortSchema>;

/** Create N numbered ports at once, e.g. eth1..eth48, or a 24-port patch panel (front+rear, paired). */
export const BulkPortsSchema = z.object({
  prefix: z.string().trim().min(1).max(32),
  count: z.number().int().min(1).max(512),
  start: z.number().int().min(0).max(10000).default(1),
  kind: PortKind.default('ethernet'),
  speedMbps: z.number().int().positive().max(1_600_000).optional(),
  /** Patch panels: also create matching rear ports and pair them front↔rear. */
  patchPanel: z.boolean().default(false),
});
export type BulkPortsInput = z.infer<typeof BulkPortsSchema>;

export const CreateCableSchema = z
  .object({
    aPortId: uuid,
    bPortId: uuid,
    media: CableMedia.default('cat6'),
    label: z.string().trim().max(64).optional(),
    lengthM: z.number().positive().max(10000).optional(),
    circuitId: z.string().trim().max(100).optional(),
  })
  .refine((c) => c.aPortId !== c.bPortId, { message: 'a cable needs two different ports', path: ['bPortId'] });
export type CreateCableInput = z.infer<typeof CreateCableSchema>;

export interface TraceHop {
  portId: string;
  portName: string;
  kind: PortKind;
  assetId: string;
  assetName: string;
  /** How we arrived at this port: the cable from the previous hop, or the panel's internal pass-through. */
  via: { type: 'start' } | { type: 'cable'; cableId: string; media: CableMedia; label: string | null } | { type: 'pass_through' };
}

export interface TraceResult {
  hops: TraceHop[];
  complete: boolean;
  /** Why tracing stopped: an end device, an uncabled port, or the loop/hop guard. */
  endReason: 'endpoint' | 'uncabled' | 'loop' | 'max_hops';
}
