import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';

/**
 * Verifies ID tokens issued to the web app by the organisation's OpenID Provider
 * (Keycloak, AD FS, Entra ID, Okta…). The web server runs the authorization-code + PKCE flow and
 * hands the ID token to the API, which trusts it only after checking signature (JWKS from the
 * issuer's discovery document), issuer, audience, expiry and freshness.
 */
export class OidcVerifier {
  private jwks?: ReturnType<typeof createRemoteJWKSet>;
  private discovered?: Promise<{ jwks_uri: string; issuer: string }>;

  constructor(
    readonly issuer: string,
    readonly clientId: string,
    /** An ID token older than this cannot open a session, even if not yet expired. */
    private readonly maxAgeSec = 300,
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OidcVerifier | null {
    if (!env.OIDC_ISSUER) return null;
    if (!env.OIDC_CLIENT_ID) throw new Error('OIDC_CLIENT_ID is required when OIDC_ISSUER is set');
    return new OidcVerifier(env.OIDC_ISSUER.replace(/\/$/, ''), env.OIDC_CLIENT_ID);
  }

  private async keys() {
    this.discovered ??= fetch(`${this.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) }).then(async (r) => {
      if (!r.ok) throw new Error(`OIDC discovery failed: HTTP ${r.status}`);
      return (await r.json()) as { jwks_uri: string; issuer: string };
    });
    const doc = await this.discovered.catch((e) => {
      this.discovered = undefined; // retry discovery next time
      throw e;
    });
    // jose caches keys and refetches on an unknown kid, so IdP key rotation needs no restart.
    this.jwks ??= createRemoteJWKSet(new URL(doc.jwks_uri));
    return { jwks: this.jwks, issuer: doc.issuer };
  }

  async verify(idToken: string): Promise<JWTPayload & Record<string, unknown>> {
    const { jwks, issuer } = await this.keys();
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer,
      audience: this.clientId,
      maxTokenAge: `${this.maxAgeSec}s`,
      algorithms: ['RS256', 'PS256', 'ES256', 'EdDSA'],
    });
    if (!payload.sub) throw new Error('ID token has no subject');
    return payload as JWTPayload & Record<string, unknown>;
  }
}
