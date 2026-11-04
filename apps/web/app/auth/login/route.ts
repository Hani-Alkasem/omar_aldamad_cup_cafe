import { generators } from 'openid-client';
import { NextResponse, type NextRequest } from 'next/server';
import { FLOW_COOKIE, oidcClient, oidcEnabled, redirectUri, safeReturnTo, secureCookies } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** Start authorization code + PKCE. State, nonce and verifier ride in a short-lived httpOnly cookie. */
export async function GET(req: NextRequest) {
  if (!oidcEnabled()) return NextResponse.redirect(new URL('/racks', req.url));
  const client = await oidcClient();
  const verifier = generators.codeVerifier();
  const state = generators.state();
  const nonce = generators.nonce();
  const url = client.authorizationUrl({
    scope: process.env.OIDC_SCOPES ?? 'openid email profile',
    redirect_uri: redirectUri(),
    code_challenge: generators.codeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  const res = NextResponse.redirect(url);
  res.cookies.set(FLOW_COOKIE, Buffer.from(JSON.stringify({ verifier, state, nonce, returnTo: safeReturnTo(req.nextUrl.searchParams.get('returnTo')) })).toString('base64url'), {
    httpOnly: true,
    secure: secureCookies(),
    sameSite: 'lax', // must survive the top-level redirect back from the IdP
    path: '/auth',
    maxAge: 600,
  });
  return res;
}
