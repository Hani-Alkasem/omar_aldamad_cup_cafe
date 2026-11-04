import { HttpStatus, Injectable } from '@nestjs/common';
import { SERVICE_TOKEN_TTL_SECONDS, type CreateServiceClientInput, type TokenRequest, type TokenResponse } from '@itam/shared';
import type { service_clients } from '@prisma/client';
import jwt from 'jsonwebtoken';
import { toDomainError } from '../../common/db-errors';
import { conflict, DomainError, notFound } from '../../common/errors';
import { PrismaService, TX_OPTIONS } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { FailureLimiter } from './rate-limit';
import { dummyHash, hashSecret, newClientSecret, prefixOf, verifySecret } from './secrets';

type Ctx = { user: AuthUser; requestId?: string };

const dto = (c: service_clients) => ({
  id: c.id,
  name: c.name,
  userId: c.user_id,
  secretPrefix: c.secret_prefix,
  secretRotatedAt: c.secret_rotated_at.toISOString(),
  expiresAt: c.expires_at?.toISOString() ?? null,
  revokedAt: c.revoked_at?.toISOString() ?? null,
  lastUsedAt: c.last_used_at?.toISOString() ?? null,
  createdAt: c.created_at.toISOString(),
});

/** One message for every failure: callers learn nothing about which part was wrong. */
const invalid = () => new DomainError(HttpStatus.UNAUTHORIZED, 'INVALID_CLIENT', 'Unknown client, wrong secret, or the client is revoked or expired');

@Injectable()
export class ServiceClientsService {
  /** Per client: a misconfigured worker trips this fast. Per IP: higher, since many clients may share a NAT. */
  private readonly byClient = new FailureLimiter(10);
  private readonly byIp = new FailureLimiter(50);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list() {
    return (await this.prisma.service_clients.findMany({ orderBy: { name: 'asc' } })).map(dto);
  }

  /** Creates the machine user and the client; the secret is returned exactly once. */
  async create(input: CreateServiceClientInput, ctx: Ctx) {
    const secret = newClientSecret();
    const hash = await hashSecret(secret);
    return this.prisma.$transaction(async (tx) => {
      const slug = input.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'client';
      try {
        const user = await tx.users.create({
          data: { email: `${slug}-${Date.now().toString(36)}@service.invalid`, display_name: `Service: ${input.name}`, role: input.role },
        });
        const c = await tx.service_clients.create({
          data: {
            name: input.name,
            user_id: user.id,
            secret_hash: hash,
            secret_prefix: prefixOf(secret),
            expires_at: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
            created_by: ctx.user.id,
          },
        });
        await this.audit.record(tx, { entity: 'service_client', entityId: c.id, action: 'create', after: dto(c), userId: ctx.user.id, requestId: ctx.requestId });
        return { ...dto(c), clientSecret: secret };
      } catch (err) {
        if (toDomainError(err)?.code === 'DUPLICATE') throw conflict('SERVICE_CLIENT_EXISTS', `A service client named "${input.name}" already exists`);
        throw err;
      }
    }, TX_OPTIONS);
  }

  /** New secret; the old one stops working at once and tokens issued before now are rejected. */
  async rotate(id: string, ctx: Ctx) {
    const secret = newClientSecret();
    const hash = await hashSecret(secret);
    return this.prisma.$transaction(async (tx) => {
      const cur = await tx.service_clients.findUnique({ where: { id } });
      if (!cur) throw notFound('Service client', id);
      if (cur.revoked_at) throw conflict('SERVICE_CLIENT_REVOKED', 'A revoked client cannot be rotated; create a new one');
      const c = await tx.service_clients.update({ where: { id }, data: { secret_hash: hash, secret_prefix: prefixOf(secret), secret_rotated_at: new Date() } });
      await this.audit.record(tx, { entity: 'service_client', entityId: id, action: 'update', before: dto(cur), after: dto(c), userId: ctx.user.id, requestId: ctx.requestId });
      return { ...dto(c), clientSecret: secret };
    }, TX_OPTIONS);
  }

  async revoke(id: string, ctx: Ctx) {
    await this.prisma.$transaction(async (tx) => {
      const cur = await tx.service_clients.findUnique({ where: { id } });
      if (!cur) throw notFound('Service client', id);
      if (cur.revoked_at) return;
      const c = await tx.service_clients.update({ where: { id }, data: { revoked_at: new Date() } });
      await this.audit.record(tx, { entity: 'service_client', entityId: id, action: 'update', before: dto(cur), after: dto(c), userId: ctx.user.id, requestId: ctx.requestId });
    }, TX_OPTIONS);
  }

  async issueToken(input: TokenRequest, ip: string): Promise<TokenResponse> {
    for (const [lim, key] of [[this.byClient, input.clientId], [this.byIp, ip]] as const) {
      const wait = lim.blockedFor(key);
      if (wait) throw new DomainError(HttpStatus.TOO_MANY_REQUESTS, 'TOO_MANY_ATTEMPTS', `Too many failed attempts; retry in ${wait} s`, { retryAfterSeconds: wait });
    }
    const c = await this.prisma.service_clients.findUnique({ where: { id: input.clientId }, include: { users_service_clients_user_idTousers: { select: { is_active: true } } } });
    const ok = c ? await verifySecret(input.clientSecret, c.secret_hash) : (await verifySecret(input.clientSecret, await dummyHash()), false);
    const usable = ok && c && !c.revoked_at && (!c.expires_at || c.expires_at > new Date()) && c.users_service_clients_user_idTousers.is_active;

    if (!usable) {
      this.byClient.fail(input.clientId);
      this.byIp.fail(ip);
      if (c) {
        await this.audit.record(this.prisma, { entity: 'service_client', entityId: c.id, action: 'access', after: { result: 'denied', ip, reason: !ok ? 'bad secret' : c.revoked_at ? 'revoked' : 'expired or inactive' } });
      }
      throw invalid();
    }
    this.byClient.clear(input.clientId);
    await this.prisma.service_clients.update({ where: { id: c.id }, data: { last_used_at: new Date() } });
    const accessToken = jwt.sign({ cid: c.id }, process.env.JWT_SECRET ?? '', { algorithm: 'HS256', subject: c.user_id, expiresIn: SERVICE_TOKEN_TTL_SECONDS });
    return { accessToken, tokenType: 'Bearer', expiresIn: SERVICE_TOKEN_TTL_SECONDS };
  }
}
