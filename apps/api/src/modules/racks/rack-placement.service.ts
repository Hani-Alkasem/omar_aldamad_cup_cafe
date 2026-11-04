import { Injectable } from '@nestjs/common';
import type { MountDepth, RackFace } from '@itam/shared';
import { conflict, notFound, unprocessable } from '../../common/errors';
import type { Tx } from '../../common/prisma.service';
import { facesBlocked, overlaps, placeableStarts, spanOf, USpan } from './rack-geometry';

export interface PlacementRequest {
  rackId: string;
  startU: number | null | undefined;
  sizeU: number;
  face: RackFace | null | undefined;
  depth: MountDepth;
  excludeAssetId?: string;
}

export interface OccupancyRow {
  assetId: string;
  name: string;
  face: RackFace;
  fromU: number;
  toU: number;
}

@Injectable()
export class RackPlacementService {
  async rackHeight(tx: Tx, rackId: string): Promise<number> {
    const rack = await tx.racks.findUnique({ where: { id: rackId }, select: { height_u: true } });
    if (!rack) throw notFound('Rack', rackId);
    return rack.height_u;
  }

  /** Occupied spans in a rack, read from the table the EXCLUDE constraint guards. */
  async occupancy(tx: Tx, rackId: string, excludeAssetId?: string): Promise<OccupancyRow[]> {
    const rows = await tx.$queryRaw<Array<{ asset_id: string; name: string; face: RackFace; from_u: number; to_u: number }>>`
      SELECT o.asset_id, a.name, o.face, lower(o.u_range) AS from_u, upper(o.u_range) - 1 AS to_u
      FROM asset_rack_occupancy o
      JOIN assets a ON a.id = o.asset_id
      WHERE o.rack_id = ${rackId}::uuid
        AND (${excludeAssetId ?? null}::uuid IS NULL OR o.asset_id <> ${excludeAssetId ?? null}::uuid)
      ORDER BY o.face, lower(o.u_range)`;
    return rows.map((r) => ({ assetId: r.asset_id, name: r.name, face: r.face, fromU: Number(r.from_u), toU: Number(r.to_u) }));
  }

  static byFace(rows: OccupancyRow[]): Record<RackFace, USpan[]> {
    return {
      front: rows.filter((r) => r.face === 'front').map(({ fromU, toU }) => ({ fromU, toU })),
      rear: rows.filter((r) => r.face === 'rear').map(({ fromU, toU }) => ({ fromU, toU })),
    };
  }

  /**
   * Friendly pre-check before writing. Locks the rack row so concurrent placements in the
   * same rack queue behind each other; the DB EXCLUDE constraint still guards every path.
   */
  async assertPlaceable(tx: Tx, req: PlacementRequest): Promise<void> {
    await tx.$queryRaw`SELECT id FROM racks WHERE id = ${req.rackId}::uuid FOR UPDATE`;
    const heightU = await this.rackHeight(tx, req.rackId);
    const faces = facesBlocked(req.depth, req.face);
    if (faces.length === 0 || req.startU == null) return; // zero-U mounts in the side channel

    const span = spanOf(req.startU, req.sizeU);
    if (span.toU > heightU) {
      throw unprocessable('RACK_U_OUT_OF_RANGE', `A ${req.sizeU}U device starting at U${req.startU} runs past the top of this ${heightU}U rack`, {
        heightU,
        maxStartU: heightU - req.sizeU + 1,
      });
    }

    const rows = await this.occupancy(tx, req.rackId, req.excludeAssetId);
    const clashes = rows.filter((r) => faces.includes(r.face) && overlaps(r, span));
    if (clashes.length === 0) return;

    const suggestions = placeableStarts(heightU, req.sizeU, faces, RackPlacementService.byFace(rows)).slice(0, 5);
    const names = [...new Set(clashes.map((c) => c.name))].join(', ');
    throw conflict('RACK_U_CONFLICT', `${span.fromU === span.toU ? `U${span.fromU}` : `U${span.fromU}–U${span.toU}`} is already occupied by ${names}`, {
      requested: { ...span, faces },
      conflicts: clashes,
      suggestedStartU: suggestions,
    });
  }
}
