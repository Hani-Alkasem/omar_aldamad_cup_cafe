import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * A session cookie the API no longer accepts (expired, revoked, user disabled). Only a route handler
 * can clear a cookie, so pages send people here instead of straight to /login (which would loop).
 */
export function GET(req: NextRequest) {
  const login = new URL('/login', req.url);
  login.searchParams.set('error', 'Your session ended. Sign in again.');
  const back = req.nextUrl.searchParams.get('returnTo');
  if (back) login.searchParams.set('returnTo', back);
  const res = NextResponse.redirect(login);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
