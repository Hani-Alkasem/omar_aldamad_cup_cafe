/**
 * Lab OpenID Provider for development, demos and tests. Not for production: use Keycloak, AD FS,
 * Entra ID or Okta and point OIDC_ISSUER at it.
 *
 * Implements just enough of OIDC Core for the web app's login: discovery, JWKS, authorization
 * code with PKCE (S256), client_secret_basic/post at the token endpoint, RS256 ID tokens with
 * nonce, and an end-session redirect.
 *
 *   pnpm --filter @itam/api lab-idp          # http://localhost:4400, client "itam-web" / "lab-secret"
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type KeyLike } from 'jose';

export interface LabUser {
  sub: string;
  email: string;
  name: string;
  groups: string[];
}

export const LAB_USERS: LabUser[] = [
  { sub: 'u-ada', email: 'ada@lab.example.com', name: 'Ada Admin', groups: ['itam-admins'] },
  { sub: 'u-nour', email: 'nour@lab.example.com', name: 'Nour Network', groups: ['itam-network'] },
  { sub: 'u-dana', email: 'dana@lab.example.com', name: 'Dana (DC-East tech)', groups: ['itam-dc-techs', 'site-dc-east'] },
  { sub: 'u-ari', email: 'ari@lab.example.com', name: 'Ari Auditor', groups: ['itam-auditors'] },
  { sub: 'u-mallory', email: 'mallory@lab.example.com', name: 'Mallory (no ITAM groups)', groups: ['marketing'] },
];

/** The mapping that matches LAB_USERS; copy into the API's environment. */
export const LAB_ROLE_MAP = { 'itam-admins': 'admin', 'itam-network': 'network_engineer', 'itam-dc-techs': 'dc_technician', 'itam-auditors': 'auditor' };
export const LAB_SITE_MAP = { 'site-dc-east': ['DC-East'] };

interface Pending {
  user: LabUser;
  clientId: string;
  redirectUri: string;
  nonce?: string;
  challenge?: string;
  expires: number;
}

export interface LabIdp {
  issuer: string;
  server: Server;
  /** Mint an ID token directly (tests). */
  idToken(user: LabUser, opts?: { aud?: string; nonce?: string; ageSec?: number; expSec?: number; extra?: Record<string, unknown> }): Promise<string>;
  close(): Promise<void>;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const b64url = (b: Buffer) => b.toString('base64url');

async function body(req: IncomingMessage): Promise<URLSearchParams> {
  let s = '';
  for await (const c of req) s += c;
  return new URLSearchParams(s);
}

export async function startLabIdp(opts: { port?: number; host?: string; clientId?: string; clientSecret?: string; publicUrl?: string } = {}): Promise<LabIdp> {
  const clientId = opts.clientId ?? 'itam-web';
  const clientSecret = opts.clientSecret ?? 'lab-secret';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'lab-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, Pending>();
  let issuer = '';

  const sign = (key: KeyLike, user: LabUser, o: { aud?: string; nonce?: string; ageSec?: number; expSec?: number; extra?: Record<string, unknown> } = {}) => {
    const iat = Math.floor(Date.now() / 1000) - (o.ageSec ?? 0);
    return new SignJWT({ email: user.email, email_verified: true, name: user.name, groups: user.groups, ...(o.nonce ? { nonce: o.nonce } : {}), ...o.extra })
      .setProtectedHeader({ alg: 'RS256', kid: 'lab-1' })
      .setIssuer(issuer)
      .setAudience(o.aud ?? clientId)
      .setSubject(user.sub)
      .setJti(b64url(randomBytes(12))) // unique per token, as real IdPs do (the API refuses reuse)
      .setIssuedAt(iat)
      .setExpirationTime(iat + (o.expSec ?? 600))
      .sign(key);
  };

  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    try {
      if (url.pathname === '/.well-known/openid-configuration') {
        return json(res, 200, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
          response_types_supported: ['code'],
          subject_types_supported: ['public'],
          id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
          scopes_supported: ['openid', 'email', 'profile', 'groups'],
        });
      }
      if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });

      if (url.pathname === '/authorize' && req.method === 'GET') {
        const q = url.searchParams;
        if (q.get('client_id') !== clientId || q.get('response_type') !== 'code') return json(res, 400, { error: 'invalid_request' });
        const hidden = [...q].map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Lab sign-in</title>
<style>body{font:15px system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}form{background:#1e293b;padding:24px;border-radius:10px;width:min(360px,90vw)}button{display:block;width:100%;margin:8px 0;padding:10px;border-radius:6px;border:1px solid #475569;background:#0f172a;color:#fff;text-align:left;cursor:pointer}small{color:#94a3b8}</style>
<form method="post" action="/authorize"><h1 style="font-size:18px;margin:0 0 4px">Lab identity provider</h1><small>Development only. Pick who to sign in as.</small>${hidden}
${LAB_USERS.map((u) => `<button name="sub" value="${esc(u.sub)}">${esc(u.name)}<br><small>${esc(u.email)} · ${esc(u.groups.join(', '))}</small></button>`).join('')}</form>`);
      }

      if (url.pathname === '/authorize' && req.method === 'POST') {
        const f = await body(req);
        const user = LAB_USERS.find((u) => u.sub === f.get('sub'));
        const redirectUri = f.get('redirect_uri') ?? '';
        if (!user || f.get('client_id') !== clientId || !/^https?:\/\//.test(redirectUri)) return json(res, 400, { error: 'invalid_request' });
        if (f.get('code_challenge') && f.get('code_challenge_method') !== 'S256') return json(res, 400, { error: 'invalid_request', error_description: 'S256 only' });
        const code = b64url(randomBytes(24));
        codes.set(code, { user, clientId, redirectUri, nonce: f.get('nonce') ?? undefined, challenge: f.get('code_challenge') ?? undefined, expires: Date.now() + 60_000 });
        const back = new URL(redirectUri);
        back.searchParams.set('code', code);
        if (f.get('state')) back.searchParams.set('state', f.get('state')!);
        back.searchParams.set('iss', issuer);
        res.writeHead(302, { location: back.toString() });
        return res.end();
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        const f = await body(req);
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const [id, secret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [f.get('client_id'), f.get('client_secret')];
        if (id !== clientId || secret !== clientSecret) return json(res, 401, { error: 'invalid_client' });
        const p = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? ''); // single use
        if (!p || p.expires < Date.now() || f.get('grant_type') !== 'authorization_code' || f.get('redirect_uri') !== p.redirectUri) return json(res, 400, { error: 'invalid_grant' });
        if (p.challenge && b64url(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) !== p.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return json(res, 200, { access_token: b64url(randomBytes(24)), token_type: 'Bearer', expires_in: 600, id_token: await sign(privateKey, p.user, { nonce: p.nonce }), scope: 'openid email profile groups' });
      }

      if (url.pathname === '/logout') {
        const to = url.searchParams.get('post_logout_redirect_uri');
        res.writeHead(to && /^https?:\/\//.test(to) ? 302 : 200, to ? { location: to } : { 'content-type': 'text/plain' });
        return res.end(to ? '' : 'Signed out of the lab identity provider.');
      }
      json(res, 404, { error: 'not_found' });
    } catch (e) {
      json(res, 500, { error: 'server_error', error_description: (e as Error).message });
    }
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  issuer = (opts.publicUrl ?? `http://${opts.host === '0.0.0.0' ? 'localhost' : (opts.host ?? '127.0.0.1')}:${port}`).replace(/\/$/, '');
  return {
    issuer,
    server,
    idToken: (user, o) => sign(privateKey, user, o),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

if (require.main === module) {
  void startLabIdp({ port: Number(process.env.LAB_IDP_PORT ?? 4400), host: process.env.LAB_IDP_HOST ?? '127.0.0.1', publicUrl: process.env.LAB_IDP_PUBLIC_URL }).then((idp) => {
    console.log(`lab IdP at ${idp.issuer} (client itam-web / lab-secret)`);
    console.log(`API env: OIDC_ISSUER=${idp.issuer} OIDC_CLIENT_ID=itam-web OIDC_ROLE_MAP='${JSON.stringify(LAB_ROLE_MAP)}' OIDC_SITE_MAP='${JSON.stringify(LAB_SITE_MAP)}'`);
  });
}
