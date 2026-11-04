import type { DiscoveryOptions, HostFacts } from '@itam/shared';
import ipaddr from 'ipaddr.js';
import type { Credential } from './types';

export type InventoryResult =
  | { kind: 'facts'; hosts: HostFacts[]; warnings: string[] }
  | { kind: 'auth_failed'; message: string }
  | { kind: 'error'; message: string };

/** vCenter, AWS and Azure: one call per endpoint returns every host and VM it knows about. */
export interface InventoryCollector {
  inventory(endpoint: string, credential: Credential, options: DiscoveryOptions): Promise<InventoryResult>;
}

/** Only strict, routable-looking addresses become facts.ip (guest tools report link-local and APIPA too). */
export function primaryIp(candidates: Array<string | null | undefined>): string | undefined {
  for (const c of candidates) {
    if (!c) continue;
    if (!(ipaddr.IPv4.isValidFourPartDecimal(c) || (c.includes(':') && ipaddr.IPv6.isValid(c)))) continue;
    const range = ipaddr.process(c).range();
    if (['linkLocal', 'loopback', 'unspecified', 'multicast'].includes(range)) continue;
    return ipaddr.process(c).toString();
  }
  return undefined;
}

/** Bounded parallel map that keeps order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

/** Provider tags can be many and long; keep a bounded, string-only subset. */
export const boundedTags = (tags: Array<{ key?: string; value?: string }> | Record<string, string> | undefined) => {
  const entries = Array.isArray(tags) ? tags.map((t) => [t.key ?? '', t.value ?? ''] as const) : Object.entries(tags ?? {});
  const kept = entries.filter(([k]) => k && !k.startsWith('aws:')).slice(0, 50).map(([k, v]) => [k.slice(0, 128), String(v).slice(0, 256)]);
  return kept.length ? Object.fromEntries(kept) : undefined;
};
