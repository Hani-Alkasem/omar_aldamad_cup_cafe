import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '@itam/shared';
import jwt from 'jsonwebtoken';
import { PrismaService } from '../../common/prisma.service';
import type { RequestWithUser } from './auth.types';
import { IS_PUBLIC, ROLES } from './decorators';

/**
 * Bearer JWT (HS256) → active user → role check.
 * The role is read from the database, not the token, so demotions apply immediately.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly secret: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) throw new Error('JWT_SECRET must be set to at least 32 characters');
    this.secret = secret;
  }

  /**
   * Machine tokens carry their client id. They die with the client (revoked, expired) and with its
   * secret (issued before the last rotation). Cached briefly: revocation applies within SERVICE_CLIENT_CACHE_MS (30 s).
   */
  private readonly clientCacheMs = Number(process.env.SERVICE_CLIENT_CACHE_MS ?? 30_000);
  private readonly clientCache = new Map<string, { at: number; revoked: boolean; expiresAt: number | null; rotatedAt: number }>();
  private async clientValid(id: string, issuedAt: number) {
    let c = this.clientCache.get(id);
    if (!c || Date.now() - c.at > this.clientCacheMs) {
      const row = await this.prisma.service_clients.findUnique({ where: { id }, select: { revoked_at: true, expires_at: true, secret_rotated_at: true } });
      if (!row) return false;
      c = { at: Date.now(), revoked: Boolean(row.revoked_at), expiresAt: row.expires_at?.getTime() ?? null, rotatedAt: row.secret_rotated_at.getTime() };
      this.clientCache.set(id, c);
    }
    // iat has second precision; allow the second in which the rotation happened.
    return !c.revoked && (c.expiresAt == null || c.expiresAt > Date.now()) && issuedAt >= Math.floor(c.rotatedAt / 1000) * 1000;
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    const header = req.header('authorization') ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Missing bearer token' });

    let sub: string;
    let clientId: string | undefined;
    let issuedAt = 0;
    try {
      const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof payload !== 'object' || typeof payload.sub !== 'string') throw new Error('no subject');
      sub = payload.sub;
      clientId = typeof payload.cid === 'string' ? payload.cid : undefined;
      issuedAt = (payload.iat ?? 0) * 1000;
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Invalid or expired token' });
    }
    if (clientId && !(await this.clientValid(clientId, issuedAt))) {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Service client revoked, expired or rotated' });
    }

    const user = await this.prisma.users.findUnique({ where: { id: sub }, select: { id: true, email: true, role: true, is_active: true } });
    if (!user || !user.is_active) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'User is inactive or unknown' });
    req.user = { id: user.id, email: user.email, role: Role.parse(user.role) };

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    // Machine accounts are deny-by-default: only routes that name the role explicitly.
    if (req.user.role === 'discovery_service' && !required?.includes('discovery_service')) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: 'Service accounts may only call internal routes' });
    }
    if (required && !required.includes(req.user.role)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `Requires role: ${required.join(' or ')}` });
    }
    return true;
  }
}

export function signToken(userId: string, secret = process.env.JWT_SECRET ?? '', expiresIn: string | number = '8h'): string {
  return jwt.sign({}, secret, { algorithm: 'HS256', subject: userId, expiresIn } as jwt.SignOptions);
}
