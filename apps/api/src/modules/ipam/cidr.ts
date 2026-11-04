import ipaddr from 'ipaddr.js';
import { unprocessable } from '../../common/errors';

export interface ParsedCidr {
  /** Canonical network form, e.g. "10.0.0.0/24" or "2001:db8::/48". */
  cidr: string;
  family: 4 | 6;
  prefix: number;
  network: string;
  broadcast: string;
}

const bitsOf = (family: 4 | 6) => (family === 4 ? 32 : 128);

/** ipaddr.js accepts legacy forms like "10.1" or "0x0a.0.0.1"; network tooling must not. */
const isStrictAddress = (text: string) =>
  text.includes(':') ? ipaddr.IPv6.isValid(text) : ipaddr.IPv4.isValidFourPartDecimal(text);

function toBigInt(addr: ipaddr.IPv4 | ipaddr.IPv6): bigint {
  return addr.toByteArray().reduce((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
}

function fromBigInt(value: bigint, family: 4 | 6): string {
  const bytes: number[] = [];
  for (let i = 0; i < bitsOf(family) / 8; i++) {
    bytes.unshift(Number(value & 0xffn));
    value >>= 8n;
  }
  return ipaddr.fromByteArray(bytes).toString();
}

/**
 * Parse a CIDR strictly: valid address, prefix in range, and no host bits set.
 * "10.0.0.5/24" is rejected with a hint pointing at "10.0.0.0/24".
 */
export function parseCidrStrict(input: string): ParsedCidr {
  const text = input.trim();
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  let prefix: number;
  try {
    if (!isStrictAddress(text.split('/')[0] ?? '')) throw new Error('not strict');
    [addr, prefix] = ipaddr.parseCIDR(text);
  } catch {
    throw unprocessable('CIDR_INVALID', `"${input}" is not a valid CIDR (expected e.g. 10.0.0.0/24 or 2001:db8::/48)`);
  }
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    throw unprocessable('CIDR_INVALID', 'IPv4-mapped IPv6 prefixes are not supported; use the IPv4 form');
  }
  const family: 4 | 6 = addr.kind() === 'ipv4' ? 4 : 6;
  const bits = BigInt(bitsOf(family));
  const hostMask = (1n << (bits - BigInt(prefix))) - 1n;
  const value = toBigInt(addr);
  const networkValue = value & ~hostMask & ((1n << bits) - 1n);
  const network = fromBigInt(networkValue, family);
  if (networkValue !== value) {
    throw unprocessable('CIDR_HOST_BITS_SET', `${text} has host bits set; did you mean ${network}/${prefix}?`, { suggestion: `${network}/${prefix}` });
  }
  return { cidr: `${network}/${prefix}`, family, prefix, network, broadcast: fromBigInt(networkValue | hostMask, family) };
}

/** Assignable host addresses. IPv4 /0–/30 lose network and broadcast; /31 (RFC 3021) and /32 keep all. */
export function usableHosts(family: 4 | 6, prefix: number): bigint {
  const size = 1n << BigInt(bitsOf(family) - prefix);
  return family === 4 && prefix < 31 ? size - 2n : size;
}

/** Normalise a single address, or throw 422. */
export function parseIp(input: string): { ip: string; family: 4 | 6 } {
  const text = input.trim().replace(/\/(32|128)$/, '');
  if (!isStrictAddress(text)) throw unprocessable('IP_INVALID', `"${input}" is not a valid IP address`);
  const addr = ipaddr.process(text); // unwraps IPv4-mapped IPv6
  return { ip: addr.toString(), family: addr.kind() === 'ipv4' ? 4 : 6 };
}

export function utilisationPct(used: number, total: bigint): number {
  if (total === 0n) return 0;
  // Scale in BigInt so huge IPv6 prefixes do not overflow Number.
  return Number((BigInt(used) * 10000n) / total) / 100;
}
