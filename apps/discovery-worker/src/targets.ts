import ipaddr from 'ipaddr.js';

const toBig = (a: ipaddr.IPv4 | ipaddr.IPv6) => a.toByteArray().reduce((n, b) => (n << 8n) | BigInt(b), 0n);
function fromBig(v: bigint, bytes: number) {
  const out: number[] = [];
  for (let i = 0; i < bytes; i++) {
    out.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  return ipaddr.fromByteArray(out).toString();
}

/**
 * Lazily yield every probe address in the targets, deduplicated, capped at maxHosts.
 * IPv4 /0–/30 skip network and broadcast; /31, /32 and IPv6 yield every address.
 * The API already validated and normalised targets; this stays defensive anyway.
 */
export function* expandTargets(cidrs: string[], maxHosts: number): Generator<string> {
  const seen = new Set<string>();
  for (const cidr of cidrs) {
    const [addr, prefix] = ipaddr.parseCIDR(cidr);
    const bits = addr.kind() === 'ipv4' ? 32 : 128;
    const size = 1n << BigInt(bits - prefix);
    const base = toBig(addr) & ~(size - 1n);
    const skipEdges = bits === 32 && prefix < 31;
    for (let i = skipEdges ? 1n : 0n; i < (skipEdges ? size - 1n : size); i++) {
      if (seen.size >= maxHosts) return;
      const ip = fromBig(base + i, bits / 8);
      if (seen.has(ip)) continue;
      seen.add(ip);
      yield ip;
    }
  }
}
