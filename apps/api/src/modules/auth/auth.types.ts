import type { Role } from '@itam/shared';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
  /** Sites the user may change; null or empty = every site. */
  siteIds?: string[] | null;
  /** Set when the request came with a web session (SSO) rather than a JWT. */
  sessionId?: string;
}

export interface RequestWithUser {
  user?: AuthUser;
  header(name: string): string | undefined;
}
