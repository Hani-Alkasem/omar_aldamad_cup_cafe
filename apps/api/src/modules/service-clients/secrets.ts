import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** scrypt N=2^15, r=8, p=1: tens of ms per verify. Parameters live in each hash, so raising them later keeps old hashes valid. */
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;

const derive = (secret: string, salt: Buffer, n: number, r: number, p: number) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(secret, salt, KEYLEN, { N: n, r, p, maxmem: 256 * n * r }, (err, key) => (err ? reject(err) : resolve(key))),
  );

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(secret, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64url'), key.toString('base64url')].join('$');
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64url');
  const got = await derive(secret, Buffer.from(salt, 'base64url'), Number(n), Number(r), Number(p));
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Burn the same CPU for unknown client ids, so response timing does not reveal which ids exist. */
let dummy: Promise<string> | undefined;
export const dummyHash = () => (dummy ??= hashSecret(randomBytes(24).toString('base64url')));

/** itamcs_<32 random bytes>; the fixed prefix lets secret scanners recognise leaked secrets. */
export const newClientSecret = () => `itamcs_${randomBytes(32).toString('base64url')}`;
export const prefixOf = (secret: string) => secret.slice(0, 14);
