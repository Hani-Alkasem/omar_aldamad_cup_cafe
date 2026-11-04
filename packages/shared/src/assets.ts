import { z } from 'zod';
import { AssetStatus, AssetType, MountDepth, RackFace } from './enums';

const uuid = z.string().uuid();

/** Rack placement: either all of rackId/startU/face (zero-U needs only rackId) or none. */
const placement = {
  rackId: uuid.nullable().optional(),
  startU: z.number().int().min(1).max(60).nullable().optional(),
  sizeU: z.number().int().min(1).max(60).default(1),
  face: RackFace.nullable().optional(),
  depth: MountDepth.default('full'),
};

const assetBase = z.object({
  name: z.string().trim().min(1).max(200),
  assetTag: z.string().trim().min(1).max(64).nullable().optional(),
  serialNumber: z.string().trim().min(1).max(128).nullable().optional(),
  type: AssetType,
  status: AssetStatus.default('active'),
  modelId: uuid.nullable().optional(),
  /** Nameplate/measured draw in watts; feeds rack power budgets. */
  powerDrawW: z.number().int().min(0).max(100_000).nullable().optional(),
  ...placement,
  customFields: z.record(z.unknown()).default({}),
});

function checkPlacement(a: { rackId?: string | null; startU?: number | null; face?: string | null; depth?: string }, ctx: z.RefinementCtx) {
  if (!a.rackId) {
    if (a.startU != null || a.face != null) ctx.addIssue({ code: 'custom', message: 'startU/face require rackId', path: ['rackId'] });
    return;
  }
  if (a.depth === 'zero_u') {
    if (a.startU != null) ctx.addIssue({ code: 'custom', message: 'zero-U devices have no startU', path: ['startU'] });
    return;
  }
  if (a.startU == null) ctx.addIssue({ code: 'custom', message: 'startU is required when racked', path: ['startU'] });
  if (a.face == null) ctx.addIssue({ code: 'custom', message: 'face is required when racked', path: ['face'] });
}

export const CreateAssetSchema = assetBase.superRefine(checkPlacement);
export type CreateAssetInput = z.infer<typeof CreateAssetSchema>;

/** Partial update; placement is re-validated against the merged record in the service. */
export const UpdateAssetSchema = assetBase.partial();
export type UpdateAssetInput = z.infer<typeof UpdateAssetSchema>;
export { checkPlacement as validatePlacement };

export const ListAssetsQuerySchema = z.object({
  type: AssetType.optional(),
  status: AssetStatus.optional(),
  rackId: uuid.optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAssetsQuery = z.infer<typeof ListAssetsQuerySchema>;
