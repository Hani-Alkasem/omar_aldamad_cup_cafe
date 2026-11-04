import type { Role } from '@itam/shared';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

export interface RequestWithUser {
  user?: AuthUser;
  header(name: string): string | undefined;
}
