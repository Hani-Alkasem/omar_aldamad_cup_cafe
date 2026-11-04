import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DomainError } from './errors';

/**
 * Postgres SQLSTATEs (standard + the KBxxx codes raised by triggers in the migrations) → API errors.
 * This is the backstop for races the service-level pre-checks cannot see.
 */
const SQLSTATE_MAP: Record<string, { status: HttpStatus; code: string }> = {
  '23P01': { status: HttpStatus.CONFLICT, code: 'RACK_U_CONFLICT' },
  '23505': { status: HttpStatus.CONFLICT, code: 'DUPLICATE' },
  '23503': { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'REFERENCE_INVALID' },
  '23514': { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'CHECK_VIOLATION' },
  '22P02': { status: HttpStatus.BAD_REQUEST, code: 'INVALID_TEXT_REPRESENTATION' },
  KB001: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'RACK_U_OUT_OF_RANGE' },
  KB002: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'RACK_PLACEMENT_INVALID' },
  KB003: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'CIDR_HOST_BITS_SET' },
  KB004: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'IP_OUTSIDE_SUBNET' },
  KB005: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'IP_RESERVED_ADDRESS' },
  KB006: { status: HttpStatus.FORBIDDEN, code: 'AUDIT_IMMUTABLE' },
  KB010: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'POWER_CONNECTION_INVALID' },
  KB011: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'PASS_THROUGH_INVALID' },
  KB012: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'FINANCIALS_INVALID' },
  KB020: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'CREDENTIAL_KIND_MISMATCH' },
};

const PRISMA_CODE_MAP: Record<string, { status: HttpStatus; code: string }> = {
  P2002: { status: HttpStatus.CONFLICT, code: 'DUPLICATE' },
  P2003: { status: HttpStatus.UNPROCESSABLE_ENTITY, code: 'REFERENCE_INVALID' },
  P2025: { status: HttpStatus.NOT_FOUND, code: 'NOT_FOUND' },
};

/** Pull the SQLSTATE out of whatever shape Prisma wrapped the driver error in. */
export function sqlStateOf(err: unknown): string | undefined {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const metaCode = (err.meta as { code?: unknown } | undefined)?.code;
    if (typeof metaCode === 'string' && /^[0-9A-Z]{5}$/.test(metaCode)) return metaCode;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /\bcode:\s*`?"?([0-9A-Z]{5})/i.exec(message)?.[1]?.toUpperCase() ?? /SqlState\(E?([0-9A-Z]{5})\)/.exec(message)?.[1];
}

/** Human-readable driver message without Prisma's invocation preamble. */
function driverMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const meta = err instanceof Prisma.PrismaClientKnownRequestError ? (err.meta as { message?: unknown } | undefined)?.message : undefined;
  const text = typeof meta === 'string' ? meta : raw;
  const quoted = /message:\s*"((?:[^"\\]|\\.)+)"/.exec(text)?.[1];
  return quoted ? quoted.replace(/\\(.)/g, '$1') : (text.split('\n').filter(Boolean).pop() ?? 'database error');
}

export function toDomainError(err: unknown): DomainError | undefined {
  if (err instanceof DomainError) return err;
  const state = sqlStateOf(err);
  if (state && SQLSTATE_MAP[state]) {
    const { status, code } = SQLSTATE_MAP[state];
    return new DomainError(status, code, driverMessage(err), { sqlstate: state });
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError && PRISMA_CODE_MAP[err.code]) {
    const { status, code } = PRISMA_CODE_MAP[err.code];
    return new DomainError(status, code, driverMessage(err), { prisma: err.code, target: err.meta?.target });
  }
  return undefined;
}

/** Postgres serialization failure / deadlock: safe to retry the whole transaction. */
export const isRetryable = (err: unknown) =>
  (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2034') || ['40001', '40P01'].includes(sqlStateOf(err) ?? '');
