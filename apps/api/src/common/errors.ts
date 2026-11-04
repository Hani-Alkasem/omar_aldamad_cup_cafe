import { HttpStatus } from '@nestjs/common';

/** Domain errors carry a stable machine code; the filter turns them into HTTP responses. */
export class DomainError extends Error {
  constructor(
    readonly status: HttpStatus,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const notFound = (entity: string, id: string) =>
  new DomainError(HttpStatus.NOT_FOUND, 'NOT_FOUND', `${entity} ${id} not found`, { entity, id });

export const conflict = (code: string, message: string, details?: Record<string, unknown>) =>
  new DomainError(HttpStatus.CONFLICT, code, message, details);

export const unprocessable = (code: string, message: string, details?: Record<string, unknown>) =>
  new DomainError(HttpStatus.UNPROCESSABLE_ENTITY, code, message, details);

export const forbidden = (code: string, message: string, details?: Record<string, unknown>) =>
  new DomainError(HttpStatus.FORBIDDEN, code, message, details);
