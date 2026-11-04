import { NextResponse, type NextRequest } from 'next/server';
import { oidcClient, oidcEnabled, SESSION_COOKIE } from '@/lib/auth';
import { rejectCrossSite } from '@/lib/proxy';

export const dynamic = 'force-dynamic';
const API_URL = process.env.API_URL ?? 'http://localhost:4000/api/v1';

/** POST only (a link must not sign people out): end the ITAM session, then the IdP session. */
export async function POST(req: NextRequest) {
  const denied = rejectCrossSite(req);
  if (denied) return denied;
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) {
    await fetch(`${API_URL}/auth/sessions/current`, { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, cache: 'no-store' }).catch(() => undefined);
  }
  let target = new URL('/login?signedOut=1', req.url).toString();
  if (oidcEnabled()) {
    try {
      const client = await oidcClient();
      if (client.issuer.metadata.end_session_endpoint) target = client.endSessionUrl({ post_logout_redirect_uri: target });
    } catch {
      // IdP unreachable: the ITAM session is already gone, which is what matters.
    }
  }
  const res = NextResponse.redirect(target, 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
