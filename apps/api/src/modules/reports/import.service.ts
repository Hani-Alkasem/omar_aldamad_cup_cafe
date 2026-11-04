import { Injectable } from '@nestjs/common';
import { AssetStatus, AssetType, CreateAssetSchema, MountDepth, RackFace, type CreateAssetInput } from '@itam/shared';
import type { assets } from '@prisma/client';
import { toDomainError } from '../../common/db-errors';
import { DomainError, unprocessable } from '../../common/errors';
import { PrismaService, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { toAssetDto, toRow } from '../assets/assets.service';
import { RackPlacementService } from '../racks/rack-placement.service';
import { ScopeService } from '../sessions/scope.service';
import { parseCsv } from './csv';

export const ASSET_COLUMNS = ['name', 'type', 'status', 'asset_tag', 'serial_number', 'site', 'rack', 'start_u', 'size_u', 'face', 'depth', 'power_draw_w'] as const;
type Column = (typeof ASSET_COLUMNS)[number];

export interface RowIssue {
  row: number; // 1-based data row, as a spreadsheet shows it (header = row 1, so +1)
  column?: Column;
  message: string;
}
export interface PlannedRow {
  row: number;
  action: 'create' | 'update' | 'unchanged';
  name: string;
  assetId?: string;
  matchedBy?: 'asset_tag' | 'serial_number';
}

const IMPORT_TX = { maxWait: 15_000, timeout: 120_000 };

/**
 * Bulk onboarding from a spreadsheet. The whole file runs in one transaction that is rolled back
 * unless every row is clean and this is not a dry run, so a dry run reports exactly what a commit
 * would do (including two rows fighting over the same U) and a bad file writes nothing. Rows match
 * existing assets by asset tag, then serial; everything else is created. Rack placement is checked
 * row by row inside one transaction, so two rows claiming the same U also collide.
 */
@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly placement: RackPlacementService,
    private readonly scope: ScopeService,
  ) {}

  private async resolveRack(tx: Tx, site: string, rack: string, cache: Map<string, string | Error>): Promise<string | Error> {
    const key = `${site.toLowerCase()}|${rack.toLowerCase()}`;
    if (cache.has(key)) return cache.get(key)!;
    const rows = await tx.$queryRaw<Array<{ id: string; site: string }>>`
      SELECT r.id, s.name AS site FROM racks r JOIN rooms rm ON rm.id = r.room_id JOIN buildings b ON b.id = rm.building_id JOIN sites s ON s.id = b.site_id
      WHERE lower(r.name) = lower(${rack}) AND (${site} = '' OR lower(s.name) = lower(${site}))`;
    const v =
      rows.length === 1
        ? rows[0].id
        : new Error(rows.length ? `rack "${rack}" exists in several sites (${rows.map((r) => r.site).join(', ')}); fill in site` : `no rack "${rack}"${site ? ` in site "${site}"` : ''}`);
    cache.set(key, v);
    return v;
  }

  private parseRow(cells: Record<string, string>, row: number, issues: RowIssue[]) {
    const get = (c: Column) => (cells[c] ?? '').trim();
    const int = (c: Column) => {
      const v = get(c);
      if (!v) return undefined;
      if (!/^\d+$/.test(v)) {
        issues.push({ row, column: c, message: `"${v}" is not a whole number` });
        return undefined;
      }
      return Number(v);
    };
    const oneOf = <T extends string>(c: Column, values: readonly T[]) => {
      const v = get(c).toLowerCase().replace(/[\s-]+/g, '_');
      if (!v) return undefined;
      if (!values.includes(v as T)) {
        issues.push({ row, column: c, message: `"${get(c)}" is not one of ${values.join(', ')}` });
        return undefined;
      }
      return v as T;
    };
    return {
      name: get('name'),
      type: oneOf('type', AssetType.options),
      status: oneOf('status', AssetStatus.options),
      assetTag: get('asset_tag') || undefined,
      serialNumber: get('serial_number') || undefined,
      site: get('site'),
      rack: get('rack'),
      startU: int('start_u'),
      sizeU: int('size_u'),
      face: oneOf('face', RackFace.options),
      depth: oneOf('depth', MountDepth.options),
      powerDrawW: int('power_draw_w'),
    };
  }

  async importAssets(csv: string, opts: { dryRun: boolean; user: AuthUser; requestId?: string }) {
    let parsed;
    try {
      parsed = parseCsv(csv);
    } catch (e) {
      throw unprocessable('CSV_INVALID', (e as Error).message);
    }
    const missing = (['name', 'type'] as const).filter((c) => !parsed.header.includes(c));
    if (missing.length) throw unprocessable('CSV_COLUMNS_MISSING', `missing column(s): ${missing.join(', ')}`, { expected: ASSET_COLUMNS });
    const unknown = parsed.header.filter((h) => h && !(ASSET_COLUMNS as readonly string[]).includes(h));
    if (!parsed.rows.length) throw unprocessable('CSV_EMPTY', 'the file has a header but no rows');

    const issues: RowIssue[] = [];
    const plan: PlannedRow[] = [];
    const rackCache = new Map<string, string | Error>();
    const seenKeys = new Map<string, number>();

    const work = async (tx: Tx) => {
      for (const [i, cells] of parsed.rows.entries()) {
        const row = i + 2;
        const record = Object.fromEntries(parsed.header.map((h, j) => [h, cells[j] ?? '']));
        const r = this.parseRow(record, row, issues);
        if (!r.name) issues.push({ row, column: 'name', message: 'name is required' });
        if (!r.type && !record.type?.trim()) issues.push({ row, column: 'type', message: 'type is required' });

        for (const [col, v] of [['asset_tag', r.assetTag], ['serial_number', r.serialNumber]] as const) {
          if (!v) continue;
          const k = `${col}:${v.toLowerCase()}`;
          if (seenKeys.has(k)) issues.push({ row, column: col, message: `duplicates row ${seenKeys.get(k)}` });
          else seenKeys.set(k, row);
        }

        let rackId: string | null | undefined;
        if (r.rack) {
          const res = await this.resolveRack(tx, r.site, r.rack, rackCache);
          if (res instanceof Error) issues.push({ row, column: 'rack', message: res.message });
          else rackId = res;
        } else if (r.site) issues.push({ row, column: 'rack', message: 'site given without a rack' });

        // Match an existing asset: asset tag first, then serial.
        let existing: assets | null = null;
        let matchedBy: PlannedRow['matchedBy'];
        if (r.assetTag) {
          existing = await tx.assets.findFirst({ where: { asset_tag: { equals: r.assetTag, mode: 'insensitive' } } });
          if (existing) matchedBy = 'asset_tag';
        }
        if (!existing && r.serialNumber) {
          existing = await tx.assets.findFirst({ where: { serial_number: r.serialNumber } });
          if (existing) matchedBy = 'serial_number';
        }
        if (issues.some((x) => x.row === row) || !r.type) continue;

        const given: Partial<CreateAssetInput> = {
          name: r.name,
          type: r.type,
          ...(r.status && { status: r.status }),
          ...(r.assetTag && { assetTag: r.assetTag }),
          ...(r.serialNumber && { serialNumber: r.serialNumber }),
          ...(rackId !== undefined && { rackId }),
          ...(r.startU !== undefined && { startU: r.startU }),
          ...(r.sizeU !== undefined && { sizeU: r.sizeU }),
          ...(r.face && { face: r.face }),
          ...(r.depth && { depth: r.depth }),
          ...(r.powerDrawW !== undefined && { powerDrawW: r.powerDrawW }),
        };
        const base = existing ? toAssetDto(existing) : {};
        const check = CreateAssetSchema.safeParse({ ...base, ...given });
        if (!check.success) {
          for (const iss of check.error.issues) issues.push({ row, column: (String(iss.path[0] ?? '').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`) || undefined) as Column, message: iss.message });
          continue;
        }
        const merged = check.data;

        try {
          await this.scope.assertRack(tx, opts.user, merged.rackId ?? null);
          if (existing) await this.scope.assertAssets(tx, opts.user, [existing.id]);
          if (merged.rackId && merged.depth !== 'zero_u') {
            await this.placement.assertPlaceable(tx, { rackId: merged.rackId, startU: merged.startU, sizeU: merged.sizeU ?? 1, face: merged.face, depth: merged.depth ?? 'full', excludeAssetId: existing?.id });
          }
        } catch (e) {
          if (!(e instanceof DomainError)) throw e;
          issues.push({ row, column: e.code.startsWith('RACK') ? 'start_u' : undefined, message: e.message });
          continue;
        }

        if (existing) {
          const changed = Object.entries(given).some(([k, v]) => JSON.stringify((base as Record<string, unknown>)[k] ?? null) !== JSON.stringify(v ?? null));
          plan.push({ row, action: changed ? 'update' : 'unchanged', name: merged.name, assetId: existing.id, matchedBy });
          if (changed) {
            const updated = await tx.assets.update({ where: { id: existing.id }, data: toRow(given) });
            await this.audit.record(tx, { entity: 'asset', entityId: existing.id, action: 'update', before: toAssetDto(existing), after: toAssetDto(updated), userId: opts.user.id, requestId: opts.requestId });
          }
        } else {
          plan.push({ row, action: 'create', name: merged.name });
          {
            const created = await tx.assets.create({ data: toRow(merged) as Parameters<typeof tx.assets.create>[0]['data'] });
            plan[plan.length - 1].assetId = created.id;
            await this.audit.record(tx, { entity: 'asset', entityId: created.id, action: 'create', after: toAssetDto(created), userId: opts.user.id, requestId: opts.requestId });
          }
        }
      }
      // Nothing is kept unless every row is clean (and never on a dry run).
      if (issues.length || opts.dryRun) throw new RollbackSignal();
    };

    try {
      await this.prisma.$transaction(work, IMPORT_TX);
    } catch (e) {
      if (!(e instanceof RollbackSignal)) {
        const d = toDomainError(e);
        if (d) throw unprocessable('IMPORT_FAILED', `the database refused the import: ${d.message}`);
        throw e;
      }
    }
    const counts = { create: plan.filter((p) => p.action === 'create').length, update: plan.filter((p) => p.action === 'update').length, unchanged: plan.filter((p) => p.action === 'unchanged').length };
    if (issues.length) {
      throw unprocessable('IMPORT_INVALID', `${issues.length} problem(s) in ${new Set(issues.map((x) => x.row)).size} row(s); nothing was imported`, { issues: issues.slice(0, 500), rows: parsed.rows.length });
    }
    return { dryRun: opts.dryRun, rows: parsed.rows.length, ...counts, ignoredColumns: unknown, plan: plan.slice(0, 1000) };
  }
}

class RollbackSignal extends Error {}
