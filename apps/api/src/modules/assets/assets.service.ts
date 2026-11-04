import { Injectable } from '@nestjs/common';
import { Prisma, type assets } from '@prisma/client';
import { CreateAssetSchema, type CreateAssetInput, type ListAssetsQuery, type UpdateAssetInput } from '@itam/shared';
import { BadRequestException } from '@nestjs/common';
import { notFound } from '../../common/errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import type { AuthUser } from '../auth/auth.types';
import { AuditService } from '../audit/audit.service';
import { RackPlacementService } from '../racks/rack-placement.service';
import { ScopeService } from '../sessions/scope.service';

export interface AssetDto {
  id: string;
  name: string;
  assetTag: string | null;
  serialNumber: string | null;
  type: assets['type'];
  status: assets['status'];
  modelId: string | null;
  rackId: string | null;
  startU: number | null;
  sizeU: number;
  face: assets['face'];
  depth: assets['depth'];
  powerDrawW: number | null;
  systemUuid: string | null;
  lastDiscoveredAt: string | null;
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export function toAssetDto(a: assets): AssetDto {
  return {
    id: a.id,
    name: a.name,
    assetTag: a.asset_tag,
    serialNumber: a.serial_number,
    type: a.type,
    status: a.status,
    modelId: a.model_id,
    rackId: a.rack_id,
    startU: a.start_u,
    sizeU: a.size_u,
    face: a.face,
    depth: a.depth,
    powerDrawW: a.power_draw_w,
    systemUuid: a.system_uuid,
    lastDiscoveredAt: a.last_discovered_at?.toISOString() ?? null,
    customFields: (a.custom_fields ?? {}) as Record<string, unknown>,
    createdAt: a.created_at.toISOString(),
    updatedAt: a.updated_at.toISOString(),
  };
}

type AssetWrite = Omit<Prisma.assetsUncheckedCreateInput, 'id'>;

export function toRow(input: Partial<CreateAssetInput>): Partial<AssetWrite> {
  const row: Partial<AssetWrite> = {};
  if (input.name !== undefined) row.name = input.name;
  if (input.assetTag !== undefined) row.asset_tag = input.assetTag;
  if (input.serialNumber !== undefined) row.serial_number = input.serialNumber;
  if (input.type !== undefined) row.type = input.type;
  if (input.status !== undefined) row.status = input.status;
  if (input.modelId !== undefined) row.model_id = input.modelId;
  if (input.powerDrawW !== undefined) row.power_draw_w = input.powerDrawW;
  if (input.rackId !== undefined) row.rack_id = input.rackId;
  if (input.startU !== undefined) row.start_u = input.startU;
  if (input.sizeU !== undefined) row.size_u = input.sizeU;
  if (input.face !== undefined) row.face = input.face;
  if (input.depth !== undefined) row.depth = input.depth;
  if (input.customFields !== undefined) row.custom_fields = input.customFields as Prisma.InputJsonValue;
  return row;
}

/** Inherit size and depth from the hardware model when the caller did not set them. */
async function applyModelDefaults(tx: Tx, input: CreateAssetInput, raw: Record<string, unknown>): Promise<CreateAssetInput> {
  if (!input.modelId) return input;
  const model = await tx.hardware_models.findUnique({ where: { id: input.modelId }, select: { size_u: true, depth: true } });
  if (!model) throw notFound('Hardware model', input.modelId);
  return {
    ...input,
    sizeU: raw.sizeU === undefined && model.size_u > 0 ? model.size_u : input.sizeU,
    depth: raw.depth === undefined ? model.depth : input.depth,
  };
}

@Injectable()
export class AssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly placement: RackPlacementService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
  ) {}

  async list(q: ListAssetsQuery) {
    const where: Prisma.assetsWhereInput = {
      type: q.type,
      status: q.status,
      rack_id: q.rackId,
      ...(q.q
        ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { asset_tag: { equals: q.q } }, { serial_number: { equals: q.q } }] }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.assets.findMany({ where, orderBy: { name: 'asc' }, take: q.limit, skip: q.offset }),
      this.prisma.assets.count({ where }),
    ]);
    return { items: items.map(toAssetDto), total, limit: q.limit, offset: q.offset };
  }

  /** Exact match on asset tag (case-insensitive) or serial number; used by QR label scans. */
  async lookup(tag: string): Promise<AssetDto> {
    const key = tag.trim();
    if (!key || key.length > 128) throw notFound('Asset', key || '(empty)');
    const hit = await this.prisma.assets.findFirst({
      where: { OR: [{ asset_tag: { equals: key, mode: 'insensitive' } }, { serial_number: key }] },
      select: { id: true },
    });
    if (!hit) throw notFound('Asset', key);
    return this.get(hit.id);
  }

  async get(id: string): Promise<AssetDto> {
    const asset = await this.prisma.assets.findUnique({ where: { id } });
    if (!asset) throw notFound('Asset', id);
    return toAssetDto(asset);
  }

  async create(input: CreateAssetInput, raw: Record<string, unknown>, user: AuthUser, requestId?: string): Promise<AssetDto> {
    return this.prisma.$transaction(async (tx) => {
      await this.scope.assertRack(tx, user, input.rackId);
      const data = await applyModelDefaults(tx, input, raw);
      if (data.rackId) await this.placement.assertPlaceable(tx, { rackId: data.rackId, startU: data.startU, sizeU: data.sizeU ?? 1, face: data.face, depth: data.depth ?? 'full' });

      const created = await tx.assets.create({ data: toRow(data) as AssetWrite });
      const dto = toAssetDto(created);
      await this.audit.record(tx, { entity: 'asset', entityId: created.id, action: 'create', after: dto, userId: user.id, requestId });
      return dto;
    }, TX_OPTIONS);
  }

  async update(id: string, patch: UpdateAssetInput, user: AuthUser, requestId?: string): Promise<AssetDto> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM assets WHERE id = ${id}::uuid FOR UPDATE`;
      if (locked.length === 0) throw notFound('Asset', id);
      const current = await tx.assets.findUniqueOrThrow({ where: { id } });
      const before = toAssetDto(current);
      // Scoped users must own the asset where it is now, and where it is going.
      await this.scope.assertAssets(tx, user, [id]);
      if (patch.rackId !== undefined && patch.rackId !== current.rack_id) await this.scope.assertRack(tx, user, patch.rackId);

      // Moving out of a rack clears the U position unless the caller supplied a new one.
      const unracking = patch.rackId === null;
      const parsed = CreateAssetSchema.safeParse({ ...before, ...patch, ...(unracking ? { startU: null, face: null } : {}) });
      if (!parsed.success) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '),
        });
      }
      const merged = parsed.data;

      const placementChanged = ['rackId', 'startU', 'sizeU', 'face', 'depth'].some((k) => k in patch) || unracking;
      if (merged.rackId && placementChanged) {
        await this.placement.assertPlaceable(tx, {
          rackId: merged.rackId,
          startU: merged.startU,
          sizeU: merged.sizeU ?? 1,
          face: merged.face,
          depth: merged.depth ?? 'full',
          excludeAssetId: id,
        });
      }

      const row = toRow({ ...patch, ...(unracking ? { startU: null, face: null } : {}) });
      const updated = await tx.assets.update({ where: { id }, data: row });
      const after = toAssetDto(updated);
      await this.audit.record(tx, { entity: 'asset', entityId: id, action: 'update', before, after, userId: user.id, requestId });
      return after;
    }, TX_OPTIONS);
  }

  async remove(id: string, user: AuthUser, requestId?: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.assets.findUnique({ where: { id } });
      if (!current) throw notFound('Asset', id);
      await this.scope.assertAssets(tx, user, [id]);
      await tx.assets.delete({ where: { id } });
      await this.audit.record(tx, { entity: 'asset', entityId: id, action: 'delete', before: toAssetDto(current), userId: user.id, requestId });
    }, TX_OPTIONS);
  }

  async history(id: string) {
    const rows = await this.prisma.audit_logs.findMany({ where: { entity: 'asset', entity_id: id }, orderBy: { at: 'desc' }, take: 100 });
    return rows.map((r) => ({
      id: r.id.toString(),
      action: r.action,
      changedFields: r.changed_fields,
      before: r.before,
      after: r.after,
      userId: r.user_id,
      at: r.at.toISOString(),
    }));
  }
}
