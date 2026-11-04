import { NextResponse, type NextRequest } from 'next/server';
import { FLOW_COOKIE, oidcClient, redirectUri, safeReturnTo, secureCookies, SESSION_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';
const API_URL = process.env.API_URL ?? 'http://localhost:4000/api/v1';

const fail = (req: NextRequest, reason: string) => {
  const res = NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(reason)}`, req.url));
  res.cookies.delete({ name: FLOW_COOKIE, path: '/auth' });
  return res;
};

/** IdP → here: verify state/nonce/PKCE, exchange the code, then open an ITAM session at the API. */
export async function GET(req: NextRequest) {
  const raw = req.cookies.get(FLOW_COOKIE)?.value;
  if (!raw) return fail(req, 'Your sign-in took too long or was started in another browser. Try again.');
  let flow: { verifier: string; state: string; nonce: string; returnTo: string };
  try {
    flow = JSON.parse(Buffer.from(raw, 'base64url').toString());
  } catch {
    return fail(req, 'Sign-in could not be completed. Try again.');
  }
  if (req.nextUrl.searchParams.get('error')) return fail(req, req.nextUrl.searchParams.get('error_description') ?? 'The identity provider refused the sign-in.');

  let idToken: string | undefined;
  try {
    const client = await oidcClient();
    const tokens = await client.callback(redirectUri(), client.callbackParams(req.nextUrl.toString()), { code_verifier: flow.verifier, state: flow.state, nonce: flow.nonce });
    idToken = tokens.id_token;
  } catch {
    return fail(req, 'Sign-in could not be verified. Try again.');
  }
  if (!idToken) return fail(req, 'The identity provider sent no ID token.');

  const r = await fetch(`${API_URL}/auth/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': req.headers.get('user-agent') ?? 'itam-web', 'x-forwarded-for': req.headers.get('x-forwarded-for') ?? '' },
    body: JSON.stringify({ idToken }),
    cache: 'no-store',
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) return fail(req, body.message ?? 'ITAM refused the sign-in.');

  const res = NextResponse.redirect(new URL(safeReturnTo(flow.returnTo), req.url));
  res.cookies.delete({ name: FLOW_COOKIE, path: '/auth' });
  res.cookies.set(SESSION_COOKIE, body.sessionToken, {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax',
    path: '/',
    expires: new Date(body.expiresAt),
  });
  return res;
}
