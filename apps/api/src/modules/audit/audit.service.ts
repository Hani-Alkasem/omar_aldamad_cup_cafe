import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Tx } from '../../common/prisma.service';

/** `access` records a read of something sensitive (a credential handed to a worker). */
export type AuditAction = 'create' | 'update' | 'delete' | 'access';

export interface AuditEntry {
  entity: string;
  entityId: string;
  action: AuditAction;
  before?: object | null;
  after?: object | null;
  userId?: string | null;
  requestId?: string | null;
}

const IGNORED_FIELDS = new Set(['updatedAt', 'updated_at']);

/** Top-level keys whose JSON value differs between two snapshots. */
export function changedFields(before?: Record<string, unknown> | null, after?: Record<string, unknown> | null): string[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter((k) => !IGNORED_FIELDS.has(k) && JSON.stringify(before?.[k] ?? null) !== JSON.stringify(after?.[k] ?? null))
    .sort();
}

/** JSON-safe snapshot (Dates → ISO strings, BigInt → string). */
export function snapshot(value: unknown): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

/**
 * Writes to the append-only audit_logs table. Always called with the caller's
 * transaction client so the audit row commits or rolls back with the change itself.
 */
@Injectable()
export class AuditService {
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    const before = entry.action === 'create' || entry.action === 'access' ? null : snapshot(entry.before ?? {});
    const after = entry.action === 'delete' ? null : snapshot(entry.after ?? {});
    const fields = changedFields(before, after);
    if (entry.action === 'update' && fields.length === 0) return;

    await tx.audit_logs.create({
      data: {
        entity: entry.entity,
        entity_id: entry.entityId,
        action: entry.action,
        before: before ? (before as Prisma.InputJsonObject) : Prisma.DbNull,
        after: after ? (after as Prisma.InputJsonObject) : Prisma.DbNull,
        changed_fields: fields,
        user_id: entry.userId ?? null,
        request_id: entry.requestId ?? null,
      },
    });
  }
}
