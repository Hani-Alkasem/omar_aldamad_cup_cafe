import 'server-only';
import { cookies } from 'next/headers';
import { Issuer, type Client } from 'openid-client';

/**
 * Web sign-in. The web server is the OIDC confidential client: it runs authorization code + PKCE
 * with the organisation's IdP, then trades the ID token for an opaque ITAM session at the API.
 * The browser only ever holds that session id, in an httpOnly cookie.
 *
 * Without OIDC_ISSUER the app falls back to the shared server-side API_TOKEN (development only).
 */
export const SESSION_COOKIE = 'itam_session';
export const FLOW_COOKIE = 'itam_oidc';
export const oidcEnabled = () => Boolean(process.env.OIDC_ISSUER);

const baseUrl = () => (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
export const redirectUri = () => process.env.OIDC_REDIRECT_URI ?? `${baseUrl()}/auth/callback`;
export const secureCookies = () => baseUrl().startsWith('https://');

let client: Promise<Client> | undefined;
export function oidcClient(): Promise<Client> {
  client ??= Issuer.discover(process.env.OIDC_ISSUER!)
    .then(
      (issuer) =>
        new issuer.Client({
          client_id: process.env.OIDC_CLIENT_ID!,
          client_secret: process.env.OIDC_CLIENT_SECRET,
          redirect_uris: [redirectUri()],
          response_types: ['code'],
          token_endpoint_auth_method: process.env.OIDC_CLIENT_SECRET ? 'client_secret_basic' : 'none',
        }),
    )
    .catch((e) => {
      client = undefined; // retry discovery on the next request
      throw e;
    });
  return client;
}

/** The token sent to the API for this request: the user's session, or the dev fallback. */
export function requestToken(): string {
  const session = cookies().get(SESSION_COOKIE)?.value;
  if (session) return session;
  return oidcEnabled() ? '' : (process.env.API_TOKEN ?? '');
}

/** Only same-site relative paths, so the login flow cannot be turned into an open redirect. */
export const safeReturnTo = (v: string | null | undefined) => (v && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : '/racks');
