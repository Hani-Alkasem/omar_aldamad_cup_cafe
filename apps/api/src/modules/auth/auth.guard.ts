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

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const req = ctx.switchToHttp().getRequest<RequestWithUser>();
    const header = req.header('authorization') ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (!token) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Missing bearer token' });

    let sub: string;
    try {
      const payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] });
      if (typeof payload !== 'object' || typeof payload.sub !== 'string') throw new Error('no subject');
      sub = payload.sub;
    } catch {
      throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'Invalid or expired token' });
    }

    const user = await this.prisma.users.findUnique({ where: { id: sub }, select: { id: true, email: true, role: true, is_active: true } });
    if (!user || !user.is_active) throw new UnauthorizedException({ code: 'UNAUTHENTICATED', message: 'User is inactive or unknown' });
    req.user = { id: user.id, email: user.email, role: Role.parse(user.role) };

    const required = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES, targets);
    if (required && !required.includes(req.user.role)) {
      throw new ForbiddenException({ code: 'FORBIDDEN', message: `Requires role: ${required.join(' or ')}` });
    }
    return true;
  }
}

export function signToken(userId: string, secret = process.env.JWT_SECRET ?? '', expiresIn: string | number = '8h'): string {
  return jwt.sign({}, secret, { algorithm: 'HS256', subject: userId, expiresIn } as jwt.SignOptions);
}
