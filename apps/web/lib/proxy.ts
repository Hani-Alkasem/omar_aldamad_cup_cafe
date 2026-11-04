import 'server-only';
import { NextResponse } from 'next/server';

export const API_URL = process.env.API_URL ?? 'http://localhost:4000/api/v1';
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Proxy routes act with the server's API token, so a cross-site page must not be able to
 * trigger them (a body-less POST is a "simple" request that skips CORS preflight).
 * Browsers always send Origin on POST/PATCH/DELETE; require it to match this host.
 */
export function rejectCrossSite(req: Request): NextResponse | null {
  const origin = req.headers.get('origin');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  let ok = false;
  try {
    ok = Boolean(origin && host && new URL(origin).host === host);
  } catch {
    ok = false;
  }
  return ok ? null : NextResponse.json({ code: 'CROSS_SITE_REQUEST', message: 'Cross-site requests are not allowed' }, { status: 403 });
}

export async function forward(path: string, init: { method: string; body?: unknown }) {
  const res = await fetch(`${API_URL}${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.API_TOKEN ?? ''}` },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: 'no-store',
  });
  return NextResponse.json(await res.json().catch(() => ({})), { status: res.status });
}
