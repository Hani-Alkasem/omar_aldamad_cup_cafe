import { z } from 'zod';

const uuid = z.string().uuid();

export const Criticality = z.enum(['tier0', 'tier1', 'tier2', 'tier3']);
export type Criticality = z.infer<typeof Criticality>;

export const CreateApplicationSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).optional(),
  owner: z.string().trim().max(200).optional(),
  criticality: Criticality.default('tier2'),
  members: z.array(z.object({ assetId: uuid, role: z.string().trim().max(100).optional() })).max(1000).default([]),
});
export type CreateApplicationInput = z.infer<typeof CreateApplicationSchema>;

export const UpdateApplicationSchema = CreateApplicationSchema.omit({ members: true }).partial();
export type UpdateApplicationInput = z.infer<typeof UpdateApplicationSchema>;

export const SetMembersSchema = z.object({ members: CreateApplicationSchema.shape.members });
export type SetMembersInput = z.infer<typeof SetMembersSchema>;

export const CreateRelationshipSchema = z
  .object({
    sourceAssetId: uuid,
    targetAssetId: uuid,
    relationshipType: z.enum(['runs_on', 'connects_to', 'depends_on']),
    ports: z.array(z.number().int().min(1).max(65535)).max(64).default([]),
    note: z.string().trim().max(500).optional(),
  })
  .refine((r) => r.sourceAssetId !== r.targetAssetId, { message: 'an asset cannot depend on itself', path: ['targetAssetId'] });
export type CreateRelationshipInput = z.infer<typeof CreateRelationshipSchema>;

export const GraphQuerySchema = z.object({
  root: uuid,
  depth: z.coerce.number().int().min(1).max(6).default(2),
  direction: z.enum(['up', 'down', 'both']).default('both'),
  includeStale: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});
export type GraphQuery = z.infer<typeof GraphQuerySchema>;

/** A discovered edge not seen for this long is shown as stale (never deleted automatically). */
export const STALE_AFTER_DAYS = 14;

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  status: string;
  applications: string[];
  isRoot: boolean;
}
export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: string;
  origin: 'manual' | 'discovery' | 'power';
  ports: number[];
  process: string | null;
  lastSeenAt: string;
  observations: number;
  stale: boolean;
}
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}
