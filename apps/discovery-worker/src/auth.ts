import type { TokenResponse } from '@itam/shared';

/** Where the worker's bearer token comes from. */
export interface TokenSource {
  get(): Promise<string>;
  /** Drop the cached token (the API answered 401). */
  invalidate(): void;
}

/** Development fallback: a pre-minted JWT (WORKER_TOKEN). */
export class StaticToken implements TokenSource {
  constructor(private readonly token: string) {}
  async get() {
    return this.token;
  }
  invalidate() {}
}

/**
 * Client-credentials exchange: POST /auth/token for a 15-minute JWT, refreshed a minute before it
 * expires. Concurrent callers share one in-flight request, so a burst of probes does not stampede the API.
 */
export class ClientCredentials implements TokenSource {
  private token?: string;
  private expiresAt = 0;
  private inflight?: Promise<string>;

  constructor(
    private readonly apiUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly refreshSkewMs = 60_000,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - this.refreshSkewMs) return this.token;
    this.inflight ??= this.fetchToken().finally(() => (this.inflight = undefined));
    return this.inflight;
  }

  invalidate() {
    this.token = undefined;
    this.expiresAt = 0;
  }

  private async fetchToken(): Promise<string> {
    const res = await this.fetchImpl(`${this.apiUrl}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grantType: 'client_credentials', clientId: this.clientId, clientSecret: this.clientSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as Partial<TokenResponse> & { message?: string };
    if (!res.ok || !body.accessToken) throw new Error(`token exchange failed (${res.status}): ${body.message ?? res.statusText}`);
    this.token = body.accessToken;
    this.expiresAt = Date.now() + (body.expiresIn ?? 900) * 1000;
    return this.token;
  }
}
