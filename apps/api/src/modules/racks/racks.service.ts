import { Injectable } from '@nestjs/common';
import { MountDepth, RackFace, type RackDevice, type RackElevation } from '@itam/shared';
import { notFound } from '../../common/errors';
import { PrismaService } from '../../common/prisma.service';
import { facesBlocked, freeSpans, placeableStarts } from './rack-geometry';
import { RackPlacementService } from './rack-placement.service';

@Injectable()
export class RacksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly placement: RackPlacementService,
  ) {}

  async list() {
    const racks = await this.prisma.racks.findMany({
      orderBy: { name: 'asc' },
      include: { rooms: { select: { name: true } }, rack_rows: { select: { name: true } }, _count: { select: { assets: true } } },
    });
    return racks.map((r) => ({
      id: r.id,
      name: r.name,
      heightU: r.height_u,
      room: r.rooms.name,
      row: r.rack_rows?.name ?? null,
      deviceCount: r._count.assets,
    }));
  }

  async elevation(rackId: string): Promise<RackElevation> {
    const rack = await this.prisma.racks.findUnique({
      where: { id: rackId },
      include: { rooms: { select: { name: true } }, rack_rows: { select: { name: true } } },
    });
    if (!rack) throw notFound('Rack', rackId);

    const assets = await this.prisma.assets.findMany({
      where: { rack_id: rackId },
      orderBy: [{ start_u: 'desc' }, { name: 'asc' }],
      include: {
        hardware_models: { select: { model_number: true, manufacturers: { select: { name: true } } } },
        _count: { select: { network_ports: true } },
      },
    });

    const devices: RackDevice[] = assets.map((a) => {
      const cf = (a.custom_fields ?? {}) as Record<string, unknown>;
      return {
        id: a.id,
        name: a.name,
        type: a.type,
        status: a.status,
        model: a.hardware_models ? `${a.hardware_models.manufacturers.name} ${a.hardware_models.model_number}` : null,
        startU: a.start_u,
        sizeU: a.size_u,
        face: a.face,
        depth: a.depth,
        powerW: a.power_draw_w,
        tempC: typeof cf.inletTempC === 'number' ? cf.inletTempC : null,
        ports: a._count.network_ports,
      };
    });

    const occupied = RackPlacementService.byFace(await this.placement.occupancy(this.prisma, rackId));
    return {
      rack: { id: rack.id, name: rack.name, heightU: rack.height_u, room: rack.rooms.name, row: rack.rack_rows?.name ?? null },
      devices,
      free: { front: freeSpans(rack.height_u, occupied.front), rear: freeSpans(rack.height_u, occupied.rear) },
    };
  }

  async freeSpace(rackId: string, sizeU: number, face: RackFace, depth: MountDepth) {
    const heightU = await this.placement.rackHeight(this.prisma, rackId);
    const occupied = RackPlacementService.byFace(await this.placement.occupancy(this.prisma, rackId));
    return { rackId, sizeU, face, depth, startU: placeableStarts(heightU, sizeU, facesBlocked(depth, face), occupied) };
  }
}
