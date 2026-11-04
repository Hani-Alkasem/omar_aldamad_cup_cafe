import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Role } from '@itam/shared';
import type { AuthUser, RequestWithUser } from './auth.types';

export const IS_PUBLIC = 'auth:public';
export const ROLES = 'auth:roles';

/** Skip authentication (health checks, OpenAPI). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Restrict a handler to these roles. Handlers without @Roles are readable by every signed-in role. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<RequestWithUser>();
  return req.user as AuthUser;
});

export const RequestId = createParamDecorator((_: unknown, ctx: ExecutionContext): string | undefined =>
  ctx.switchToHttp().getRequest<RequestWithUser>().header('x-request-id'),
);
