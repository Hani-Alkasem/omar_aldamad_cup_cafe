import { parseCidrStrict, usableHosts } from '../ipam/cidr';
import { unprocessable } from '../../common/errors';

/** Smallest IPv6 sweep we accept: /112 is 65,536 addresses. Larger v6 ranges are not scannable. */
const MIN_V6_PREFIX = 112;

/**
 * Normalise targets to canonical CIDRs (a bare address becomes /32 or /128), reject overlaps and
 * oversized ranges, and return the host count the worker will probe.
 */
export function normaliseTargets(targets: string[], maxHosts: number): { cidrs: string[]; hosts: number } {
  const parsed = targets.map((t) => {
    const text = t.includes('/') ? t : `${t}/${t.includes(':') ? 128 : 32}`;
    const c = parseCidrStrict(text);
    if (c.family === 6 && c.prefix < MIN_V6_PREFIX) {
      throw unprocessable('TARGET_TOO_LARGE', `${c.cidr} is too large to sweep; IPv6 targets must be /${MIN_V6_PREFIX} or smaller`);
    }
    return c;
  });
  const unique = [...new Map(parsed.map((c) => [c.cidr, c])).values()];
  const hosts = unique.reduce((n, c) => n + Number(c.prefix >= (c.family === 4 ? 31 : 127) ? 1n << BigInt((c.family === 4 ? 32 : 128) - c.prefix) : usableHosts(c.family, c.prefix)), 0);
  if (hosts > maxHosts) {
    throw unprocessable('TARGETS_EXCEED_MAX_HOSTS', `targets cover ${hosts} hosts but maxHosts is ${maxHosts}; raise maxHosts or split the job`, { hosts, maxHosts });
  }
  return { cidrs: unique.map((c) => c.cidr), hosts };
}
