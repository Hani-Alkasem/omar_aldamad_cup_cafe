import ipaddr from 'ipaddr.js';

export type QueryKind =
  | { kind: 'ip'; ip: string }
  | { kind: 'cidr'; cidr: string }
  | { kind: 'mac'; mac: string; alsoText: boolean }
  | { kind: 'uuid'; id: string }
  | { kind: 'text'; text: string };

const strictV4 = (s: string) => ipaddr.IPv4.isValidFourPartDecimal(s);

/** "aa:bb:cc:dd:ee:ff", "AA-BB-…", Cisco "aabb.ccdd.eeff" or bare "aabbccddeeff" → canonical lower-case colon form. */
export function normaliseMac(s: string): string | null {
  const hex = s.trim().toLowerCase().replace(/[:.\-]/g, '');
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  const shaped = /^([0-9a-f]{2}([:-])){5}[0-9a-f]{2}$/i.test(s.trim()) || /^[0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4}$/i.test(s.trim()) || /^[0-9a-f]{12}$/i.test(s.trim());
  return shaped ? hex.match(/../g)!.join(':') : null;
}

/**
 * What the user typed decides where to look. Bare 12-hex strings could be a MAC or a serial, so
 * they are searched as both.
 */
export function classify(raw: string): QueryKind {
  const q = raw.trim();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(q)) return { kind: 'uuid', id: q.toLowerCase() };
  if (q.includes('/')) {
    const [addr, bits] = q.split('/');
    if ((strictV4(addr) || (addr.includes(':') && ipaddr.IPv6.isValid(addr))) && /^\d{1,3}$/.test(bits)) {
      try {
        const [a, p] = ipaddr.parseCIDR(q);
        return { kind: 'cidr', cidr: `${a.toString()}/${p}` };
      } catch {
        /* fall through to text */
      }
    }
  }
  if (strictV4(q) || (q.includes(':') && !normaliseMac(q) && ipaddr.IPv6.isValid(q))) return { kind: 'ip', ip: ipaddr.process(q).toString() };
  const mac = normaliseMac(q);
  if (mac) return { kind: 'mac', mac, alsoText: /^[0-9a-f]{12}$/i.test(q) };
  return { kind: 'text', text: q };
}
