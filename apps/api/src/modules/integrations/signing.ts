import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Stripe-style signature: the timestamp is signed with the body, so captured requests cannot be replayed later. */
export function sign(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

/** Reference verifier for receivers (also used in tests). Rejects signatures older than toleranceSec. */
export function verify(secret: string, body: string, header: string, toleranceSec = 300, now = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now - t) > toleranceSec || !parts.v1) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.${body}`).digest('hex'));
  const given = Buffer.from(parts.v1);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const newSigningSecret = () => `whsec_${randomBytes(32).toString('base64url')}`;
