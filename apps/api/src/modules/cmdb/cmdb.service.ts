import { Injectable } from '@nestjs/common';
import { STALE_AFTER_DAYS, type CreateApplicationInput, type CreateRelationshipInput, type Graph, type GraphEdge, type GraphQuery, type SetMembersInput, type UpdateApplicationInput } from '@itam/shared';
import type { applications, ci_relationships } from '@prisma/client';
import { toDomainError } from '../../common/db-errors';
import { conflict, notFound } from '../../common/errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';

type Ctx = { user: AuthUser; requestId?: string };

/** Keeps the browser responsive; a bigger graph is truncated and says so. */
const MAX_EDGES = 2000;
const staleBefore = () => new Date(Date.now() - STALE_AFTER_DAYS * 86_400_000);

const edgeDto = (r: ci_relationships): GraphEdge => {
  const a = (r.attributes ?? {}) as { ports?: number[]; process?: string | null };
  return {
    id: r.id,
    source: r.source_asset_id,
    target: r.target_asset_id,
    type: r.relationship_type,
    origin: r.source as GraphEdge['origin'],
    ports: a.ports ?? [],
    process: a.process ?? null,
    lastSeenAt: r.last_seen_at.toISOString(),
    observations: r.observation_count,
    stale: r.source === 'discovery' && r.last_seen_at < staleBefore(),
  };
};

const appDto = (a: applications & { application_members?: Array<{ asset_id: string; role: string | null; assets?: { name: string; type: string; status: string } }> }) => ({
  id: a.id,
  name: a.name,
  description: a.description,
  owner: a.owner,
  criticality: a.criticality,
  members: (a.application_members ?? []).map((m) => ({ assetId: m.asset_id, role: m.role, name: m.assets?.name, type: m.assets?.type, status: m.assets?.status })),
  createdAt: a.created_at.toISOString(),
  updatedAt: a.updated_at.toISOString(),
});

@Injectable()
export class CmdbService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private async requireAsset(tx: Tx, id: string) {
    const a = await tx.assets.findUnique({ where: { id }, select: { id: true, name: true } });
    if (!a) throw notFound('Asset', id);
    return a;
  }

  /** Nodes for a set of edges plus the given extra ids, tagged with the applications they belong to. */
  private async build(edges: ci_relationships[], extra: string[], root: string | null, truncated: boolean): Promise<Graph> {
    const ids = [...new Set([...extra, ...edges.flatMap((e) => [e.source_asset_id, e.target_asset_id])])];
    const assets = await this.prisma.assets.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, type: true, status: true, application_members: { select: { applications: { select: { name: true } } } } },
    });
    return {
      nodes: assets.map((a) => ({ id: a.id, name: a.name, type: a.type, status: a.status, applications: a.application_members.map((m) => m.applications.name).sort(), isRoot: a.id === root })),
      edges: edges.map(edgeDto),
      truncated,
    };
  }

  async graph(q: GraphQuery): Promise<Graph> {
    await this.requireAsset(this.prisma, q.root);
    const ids = await this.prisma.$queryRaw<Array<{ edge_id: string }>>`
      SELECT g.edge_id FROM ci_dependency_graph(${q.root}::uuid, ${q.depth}::int, ${q.direction}::text) g
      JOIN ci_relationships r ON r.id = g.edge_id
      WHERE ${q.includeStale}::boolean OR r.source <> 'discovery' OR r.last_seen_at >= ${staleBefore()}
      ORDER BY g.depth, g.edge_id LIMIT ${MAX_EDGES + 1}`;
    const truncated = ids.length > MAX_EDGES;
    const edges = await this.prisma.ci_relationships.findMany({ where: { id: { in: ids.slice(0, MAX_EDGES).map((i) => i.edge_id) } } });
    return this.build(edges, [q.root], q.root, truncated);
  }

  /** Blast radius: everything that transitively depends on (or is powered by) this asset, and the applications touched. */
  async impact(id: string) {
    const root = await this.requireAsset(this.prisma, id);
    const rows = await this.prisma.$queryRaw<Array<{ asset_id: string; depth: number; name: string; type: string; status: string }>>`
      SELECT i.asset_id, i.depth, a.name, a.type, a.status FROM ci_impacted_by(${id}::uuid, 10) i JOIN assets a ON a.id = i.asset_id
      ORDER BY i.depth, a.name`;
    const affected = [id, ...rows.map((r) => r.asset_id)];
    const apps = await this.prisma.applications.findMany({
      where: { application_members: { some: { asset_id: { in: affected } } } },
      select: { id: true, name: true, criticality: true },
      orderBy: [{ criticality: 'asc' }, { name: 'asc' }],
    });
    return {
      root,
      assets: rows.map((r) => ({ id: r.asset_id, name: r.name, type: r.type, status: r.status, depth: r.depth })),
      applications: apps,
    };
  }

  async createRelationship(input: CreateRelationshipInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      await this.requireAsset(tx, input.sourceAssetId);
      await this.requireAsset(tx, input.targetAssetId);
      try {
        const r = await tx.ci_relationships.create({
          data: {
            source_asset_id: input.sourceAssetId,
            target_asset_id: input.targetAssetId,
            relationship_type: input.relationshipType,
            source: 'manual',
            attributes: { ports: input.ports, process: null, ...(input.note ? { note: input.note } : {}) },
          },
        });
        const dto = edgeDto(r);
        await this.audit.record(tx, { entity: 'ci_relationship', entityId: r.id, action: 'create', after: dto, userId: ctx.user.id, requestId: ctx.requestId });
        return dto;
      } catch (err) {
        if (toDomainError(err)?.code === 'DUPLICATE') throw conflict('RELATIONSHIP_EXISTS', 'That relationship already exists');
        throw err;
      }
    }, TX_OPTIONS);
  }

  /**
   * Manual edges can always be removed. Discovered edges only once stale (otherwise the next run
   * would recreate them); power edges follow the cords and are removed by unplugging.
   */
  async deleteRelationship(id: string, ctx: Ctx) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.ci_relationships.findUnique({ where: { id } });
      if (!r) throw notFound('Relationship', id);
      const dto = edgeDto(r);
      if (r.source === 'power') throw conflict('POWER_EDGE_READONLY', 'Power relationships follow the power cords; unplug the cord instead');
      if (r.source === 'discovery' && !dto.stale) {
        throw conflict('DISCOVERED_EDGE_ACTIVE', `Discovery saw this dependency on ${dto.lastSeenAt.slice(0, 10)}; it can be removed once it has been idle for ${STALE_AFTER_DAYS} days`);
      }
      await tx.ci_relationships.delete({ where: { id } });
      await this.audit.record(tx, { entity: 'ci_relationship', entityId: id, action: 'delete', before: dto, userId: ctx.user.id, requestId: ctx.requestId });
    }, TX_OPTIONS);
  }

  /* ---------- applications ---------- */

  private readonly appInclude = { application_members: { include: { assets: { select: { name: true, type: true, status: true } } }, orderBy: { asset_id: 'asc' as const } } };

  async listApplications() {
    const rows = await this.prisma.applications.findMany({ include: this.appInclude, orderBy: [{ criticality: 'asc' }, { name: 'asc' }] });
    return rows.map(appDto);
  }

  async getApplication(id: string, tx: Tx = this.prisma) {
    const a = await tx.applications.findUnique({ where: { id }, include: this.appInclude });
    if (!a) throw notFound('Application', id);
    return appDto(a);
  }

  private async writeMembers(tx: Tx, appId: string, members: SetMembersInput['members']) {
    const ids = members.map((m) => m.assetId);
    if (new Set(ids).size !== ids.length) throw conflict('MEMBER_DUPLICATE', 'An asset is listed twice');
    const found = await tx.assets.findMany({ where: { id: { in: ids } }, select: { id: true } });
    const missing = ids.find((i) => !found.some((f) => f.id === i));
    if (missing) throw notFound('Asset', missing);
    await tx.application_members.deleteMany({ where: { application_id: appId } });
    await tx.application_members.createMany({ data: members.map((m) => ({ application_id: appId, asset_id: m.assetId, role: m.role ?? null })) });
  }

  private dupName(err: unknown, name?: string): never {
    if (toDomainError(err)?.code === 'DUPLICATE') throw conflict('APPLICATION_EXISTS', `An application named "${name}" already exists`);
    throw err;
  }

  async createApplication(input: CreateApplicationInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      let id: string;
      try {
        ({ id } = await tx.applications.create({ data: { name: input.name, description: input.description, owner: input.owner, criticality: input.criticality } }));
      } catch (err) {
        this.dupName(err, input.name);
      }
      await this.writeMembers(tx, id, input.members);
      const dto = await this.getApplication(id, tx);
      await this.audit.record(tx, { entity: 'application', entityId: id, action: 'create', after: dto, userId: ctx.user.id, requestId: ctx.requestId });
      return dto;
    }, TX_OPTIONS);
  }

  async updateApplication(id: string, input: UpdateApplicationInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.getApplication(id, tx);
      try {
        await tx.applications.update({ where: { id }, data: input });
      } catch (err) {
        this.dupName(err, input.name);
      }
      const after = await this.getApplication(id, tx);
      await this.audit.record(tx, { entity: 'application', entityId: id, action: 'update', before, after, userId: ctx.user.id, requestId: ctx.requestId });
      return after;
    }, TX_OPTIONS);
  }

  async setMembers(id: string, input: SetMembersInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.getApplication(id, tx);
      await this.writeMembers(tx, id, input.members);
      const after = await this.getApplication(id, tx);
      await this.audit.record(tx, { entity: 'application', entityId: id, action: 'update', before: { members: before.members }, after: { members: after.members }, userId: ctx.user.id, requestId: ctx.requestId });
      return after;
    }, TX_OPTIONS);
  }

  async deleteApplication(id: string, ctx: Ctx) {
    await this.prisma.$transaction(async (tx) => {
      const before = await this.getApplication(id, tx);
      await tx.applications.delete({ where: { id } });
      await this.audit.record(tx, { entity: 'application', entityId: id, action: 'delete', before, userId: ctx.user.id, requestId: ctx.requestId });
    }, TX_OPTIONS);
  }

  /** Members, the edges among them, and one hop outward in both directions. */
  async applicationGraph(id: string, includeStale = false): Promise<Graph> {
    const app = await this.getApplication(id);
    const members = app.members.map((m) => m.assetId);
    const edges = await this.prisma.ci_relationships.findMany({
      where: {
        OR: [{ source_asset_id: { in: members } }, { target_asset_id: { in: members } }],
        ...(includeStale ? {} : { NOT: { source: 'discovery', last_seen_at: { lt: staleBefore() } } }),
      },
      take: MAX_EDGES + 1,
      orderBy: { id: 'asc' },
    });
    return this.build(edges.slice(0, MAX_EDGES), members, null, edges.length > MAX_EDGES);
  }
}
