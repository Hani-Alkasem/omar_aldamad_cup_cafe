import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { SECRET_SCHEMAS, type CreateCredentialInput, type CredentialKind, type CredentialSecret, type RotateSecretInput } from '@itam/shared';
import type { credentials } from '@prisma/client';
import { toDomainError } from '../../common/db-errors';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { Vault, VaultError } from './vault';

type Ctx = { user: AuthUser; requestId?: string };

/** Public shape: metadata only. There is deliberately no route that returns a secret. */
export const credentialDto = (c: credentials & { _count?: { job_credentials: number } }) => ({
  id: c.id,
  name: c.name,
  kind: c.kind,
  username: c.username,
  keyId: c.key_id,
  lastUsedAt: c.last_used_at?.toISOString() ?? null,
  usedByJobs: c._count?.job_credentials ?? 0,
  createdAt: c.created_at.toISOString(),
  updatedAt: c.updated_at.toISOString(),
});

function parseSecret(kind: CredentialKind, raw: unknown) {
  const r = SECRET_SCHEMAS[kind].safeParse(raw);
  if (!r.success) throw unprocessable('CREDENTIAL_SECRET_INVALID', `secret does not fit ${kind}`, { issues: r.error.issues.map((i) => ({ path: i.path, message: i.message })) });
  return r.data;
}

@Injectable()
export class CredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly vault: Vault,
  ) {}

  async list() {
    const rows = await this.prisma.credentials.findMany({ orderBy: { name: 'asc' }, include: { _count: { select: { job_credentials: true } } } });
    return rows.map(credentialDto);
  }

  async create(input: CreateCredentialInput, ctx: Ctx) {
    const id = randomUUID();
    const sealed = this.vault.seal(parseSecret(input.kind, input.secret), { id, kind: input.kind });
    return this.prisma.$transaction(async (tx) => {
      try {
        const c = await tx.credentials.create({
          data: {
            id,
            name: input.name,
            kind: input.kind,
            username: input.username ?? null,
            secret_ciphertext: sealed.ciphertext,
            secret_iv: sealed.iv,
            secret_tag: sealed.tag,
            key_id: sealed.keyId,
            created_by: ctx.user.id,
          },
        });
        const dto = credentialDto(c);
        // Audit the metadata only; the secret never enters audit_logs.
        await this.audit.record(tx, { entity: 'credential', entityId: id, action: 'create', after: dto, userId: ctx.user.id, requestId: ctx.requestId });
        return dto;
      } catch (err) {
        if (toDomainError(err)?.code === 'DUPLICATE') throw conflict('CREDENTIAL_EXISTS', `A credential named "${input.name}" already exists`);
        throw err;
      }
    }, TX_OPTIONS);
  }

  /** Replace the secret (and re-seal with the current key). */
  async rotate(id: string, input: RotateSecretInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const c = await tx.credentials.findUnique({ where: { id } });
      if (!c) throw notFound('Credential', id);
      const sealed = this.vault.seal(parseSecret(c.kind, input.secret), { id, kind: c.kind });
      const updated = await tx.credentials.update({
        where: { id },
        data: { secret_ciphertext: sealed.ciphertext, secret_iv: sealed.iv, secret_tag: sealed.tag, key_id: sealed.keyId },
      });
      await this.audit.record(tx, {
        entity: 'credential',
        entityId: id,
        action: 'update',
        before: { secretVersion: c.updated_at.toISOString(), keyId: c.key_id },
        after: { secretVersion: updated.updated_at.toISOString(), keyId: updated.key_id },
        userId: ctx.user.id,
        requestId: ctx.requestId,
      });
      return credentialDto(updated);
    }, TX_OPTIONS);
  }

  async remove(id: string, ctx: Ctx) {
    await this.prisma.$transaction(async (tx) => {
      const c = await tx.credentials.findUnique({ where: { id }, include: { _count: { select: { job_credentials: true } } } });
      if (!c) throw notFound('Credential', id);
      if (c._count.job_credentials > 0) throw conflict('CREDENTIAL_IN_USE', `Used by ${c._count.job_credentials} discovery job(s); detach it first`);
      await tx.credentials.delete({ where: { id } });
      await this.audit.record(tx, { entity: 'credential', entityId: id, action: 'delete', before: credentialDto(c), userId: ctx.user.id, requestId: ctx.requestId });
    }, TX_OPTIONS);
  }

  /**
   * Decrypt a job's credentials for a worker, in job order. Each hand-out is audited as `access`.
   * Rows that cannot be opened are skipped (and reported) so one bad row does not stall discovery.
   */
  async openForJob(tx: Tx, jobId: string, ctx: { userId: string; runId: string; requestId?: string }) {
    const links = await tx.job_credentials.findMany({ where: { job_id: jobId }, orderBy: { position: 'asc' }, include: { credentials: true } });
    const opened: Array<CredentialSecret & { id: string; name: string; username: string | null }> = [];
    const unreadable: string[] = [];
    for (const { credentials: c } of links) {
      try {
        const secret = this.vault.open({ ciphertext: Buffer.from(c.secret_ciphertext), iv: Buffer.from(c.secret_iv), tag: Buffer.from(c.secret_tag), keyId: c.key_id }, { id: c.id, kind: c.kind });
        opened.push({ id: c.id, name: c.name, username: c.username, kind: c.kind, secret } as never);
      } catch (e) {
        if (!(e instanceof VaultError)) throw e;
        unreadable.push(c.name);
        continue;
      }
      await this.audit.record(tx, { entity: 'credential', entityId: c.id, action: 'access', after: { runId: ctx.runId, jobId }, userId: ctx.userId, requestId: ctx.requestId });
    }
    if (opened.length) await tx.credentials.updateMany({ where: { id: { in: opened.map((o) => o.id) } }, data: { last_used_at: new Date() } });
    return { opened, unreadable };
  }
}
