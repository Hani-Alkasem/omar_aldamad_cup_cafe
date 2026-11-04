import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

export interface RequestContext {
  requestId: string;
}

/** Per-request context, readable anywhere in the call chain (logs, audit rows). */
export const requestContext = new AsyncLocalStorage<RequestContext>();

const VALID_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Accepts a caller's X-Request-Id (from the web proxy or a load balancer) when it is well formed,
 * otherwise mints one; echoes it on the response so a user's error report can be matched to logs.
 */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction) {
  const given = req.header('x-request-id');
  const requestId = given && VALID_ID.test(given) ? given : randomUUID();
  req.headers['x-request-id'] = requestId;
  res.setHeader('x-request-id', requestId);
  requestContext.run({ requestId }, next);
}
