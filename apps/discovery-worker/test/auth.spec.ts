import { ClientCredentials } from '../src/auth';

const response = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('ClientCredentials', () => {
  it('caches the token, shares one in-flight exchange, and refreshes ahead of expiry', async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return response(200, { accessToken: `t${calls}`, tokenType: 'Bearer', expiresIn: 900 });
    }) as unknown as typeof fetch;
    const src = new ClientCredentials('http://api', 'id', 'secret', 60_000, fetchImpl);
    const [a, b] = await Promise.all([src.get(), src.get()]);
    expect([a, b, calls]).toEqual(['t1', 't1', 1]);
    expect(await src.get()).toBe('t1');
    src.invalidate();
    expect(await src.get()).toBe('t2');

    let shortCalls = 0;
    const short = new ClientCredentials('http://api', 'id', 'secret', 60_000, (async () => (shortCalls++, response(200, { accessToken: 'x', expiresIn: 30 }))) as unknown as typeof fetch);
    await short.get();
    await short.get();
    // expiresIn (30 s) is inside the 60 s refresh window: each call refreshes instead of reusing a dying token.
    expect(shortCalls).toBe(2);
  });

  it('reports a rejected exchange clearly', async () => {
    const src = new ClientCredentials('http://api', 'id', 'bad', 60_000, (async () => response(401, { message: 'Unknown client, wrong secret, or the client is revoked or expired' })) as unknown as typeof fetch);
    await expect(src.get()).rejects.toThrow(/token exchange failed \(401\): Unknown client/);
  });
});
