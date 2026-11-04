import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { CreateComponentInput } from '@itam/shared';
import { notFound } from '../../common/errors';
import { PrismaService, TX_OPTIONS } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';

const toDto = (c: Prisma.asset_componentsGetPayload<object>) => ({
  id: c.id,
  assetId: c.asset_id,
  kind: c.kind,
  slot: c.slot,
  manufacturer: c.manufacturer,
  model: c.model,
  serialNumber: c.serial_number,
  capacity: c.capacity == null ? null : Number(c.capacity),
  attributes: c.attributes as Record<string, unknown>,
});

@Injectable()
export class ComponentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Components plus a hardware summary: CPU cores, memory GB, raw disk GB, GPU count. */
  async list(assetId: string) {
    if (!(await this.prisma.assets.findUnique({ where: { id: assetId }, select: { id: true } }))) throw notFound('Asset', assetId);
    const items = (await this.prisma.asset_components.findMany({ where: { asset_id: assetId }, orderBy: [{ kind: 'asc' }, { slot: 'asc' }] })).map(toDto);
    const sum = (kind: string) => items.filter((i) => i.kind === kind).reduce((s, i) => s + (i.capacity ?? 0), 0);
    return {
      items,
      summary: { cpuCores: sum('cpu'), memoryGb: sum('memory'), diskGb: sum('disk'), gpus: items.filter((i) => i.kind === 'gpu').length },
    };
  }

  async create(assetId: string, input: CreateComponentInput, user: AuthUser, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.assets.findUnique({ where: { id: assetId }, select: { id: true } }))) throw notFound('Asset', assetId);
      const c = await tx.asset_components.create({
        data: {
          asset_id: assetId,
          kind: input.kind,
          slot: input.slot,
          manufacturer: input.manufacturer,
          model: input.model,
          serial_number: input.serialNumber,
          capacity: input.capacity,
          attributes: input.attributes as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(tx, { entity: 'asset_component', entityId: c.id, action: 'create', after: toDto(c), userId: user.id, requestId });
      return toDto(c);
    }, TX_OPTIONS);
  }

  async remove(id: string, user: AuthUser, requestId?: string) {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.asset_components.findUnique({ where: { id } });
      if (!c) throw notFound('Component', id);
      await tx.asset_components.delete({ where: { id } });
      await this.audit.record(tx, { entity: 'asset_component', entityId: id, action: 'delete', before: toDto(c), userId: user.id, requestId });
    }, TX_OPTIONS);
  }
}
