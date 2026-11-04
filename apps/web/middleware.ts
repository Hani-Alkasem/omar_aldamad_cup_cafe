import { NextResponse, type NextRequest } from 'next/server';

/**
 * With SSO on, every page needs a session cookie; the API still validates it on each call
 * (this only spares users a broken page). Auth routes, the login page and static files are open.
 */
export function middleware(req: NextRequest) {
  if (!process.env.OIDC_ISSUER) return NextResponse.next();
  if (req.cookies.get('itam_session')) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith('/api/')) return NextResponse.json({ code: 'UNAUTHENTICATED', message: 'Sign in first' }, { status: 401 });
  const login = new URL('/login', req.url);
  login.searchParams.set('returnTo', req.nextUrl.pathname + req.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = { matcher: ['/((?!login|auth/|_next/|favicon\\.ico|racks/demo).*)'] };
