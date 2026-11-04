import type { AssetType, ParsedHostFacts } from '@itam/shared';

/**
 * Identity resolution for discovered hosts. Pure: the service feeds it lookups and applies the plan.
 *
 * Keys, strongest first: SMBIOS system UUID → serial number → MAC → IP.
 * - UUID, serial and MAC are hardware identity. If they point at different assets the host is a
 *   conflict and nothing is written: a human decides (e.g. a NIC moved between servers).
 * - IP is circumstantial (DHCP, re-use). It only matches when no hardware key matched and the
 *   asset at that IP does not carry a different serial or UUID.
 * - A matched asset whose stored serial/UUID disagrees with the host's is a conflict too.
 * - A changed SSH host key is a conflict: it may be a reinstall, or a machine impersonating one.
 */

export type MatchKey = 'system_uuid' | 'serial' | 'mac' | 'ip';

export interface KnownAsset {
  id: string;
  name: string;
  serialNumber: string | null;
  systemUuid: string | null;
  sshHostKey: string | null;
}

export interface Lookups {
  bySystemUuid: KnownAsset[];
  bySerial: KnownAsset[];
  byMac: KnownAsset[];
  byIp: KnownAsset[];
}

export type Match =
  | { kind: 'create' }
  | { kind: 'match'; asset: KnownAsset; matchedBy: MatchKey }
  | { kind: 'conflict'; reason: string; candidates: Array<{ id: string; name: string; via: MatchKey }> };

const differs = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b && a.toLowerCase() !== b.toLowerCase());

export function resolveIdentity(facts: ParsedHostFacts, l: Lookups): Match {
  const hardware: Array<[MatchKey, KnownAsset[]]> = [
    ['system_uuid', l.bySystemUuid],
    ['serial', l.bySerial],
    ['mac', l.byMac],
  ];
  const seen = new Map<string, { asset: KnownAsset; via: MatchKey }>();
  for (const [via, list] of hardware) for (const a of list) if (!seen.has(a.id)) seen.set(a.id, { asset: a, via });

  let match: { asset: KnownAsset; matchedBy: MatchKey } | undefined;
  if (seen.size > 1) {
    return {
      kind: 'conflict',
      reason: 'hardware identifiers point at different assets',
      candidates: [...seen.values()].map(({ asset, via }) => ({ id: asset.id, name: asset.name, via })),
    };
  }
  if (seen.size === 1) {
    const [{ asset, via }] = seen.values();
    match = { asset, matchedBy: via };
  } else {
    const ipHits = l.byIp.filter((a) => !differs(a.serialNumber, facts.serialNumber) && !differs(a.systemUuid, facts.systemUuid));
    if (ipHits.length === 1) match = { asset: ipHits[0], matchedBy: 'ip' };
  }
  if (!match) return { kind: 'create' };

  const { asset } = match;
  const one = (reason: string): Match => ({ kind: 'conflict', reason, candidates: [{ id: asset.id, name: asset.name, via: match.matchedBy }] });
  if (differs(asset.systemUuid, facts.systemUuid)) return one(`system UUID ${facts.systemUuid} does not match ${asset.name}'s ${asset.systemUuid}`);
  if (differs(asset.serialNumber, facts.serialNumber)) return one(`serial ${facts.serialNumber} does not match ${asset.name}'s ${asset.serialNumber}`);
  if (asset.sshHostKey && facts.sshHostKey && asset.sshHostKey !== facts.sshHostKey) {
    return one(`SSH host key changed (was ${asset.sshHostKey}, now ${facts.sshHostKey}); confirm the reinstall before accepting`);
  }
  return { kind: 'match', ...match };
}

const SNMP_TYPES: Array<[RegExp, AssetType]> = [
  [/\b(fortigate|fortios|pan-?os|palo alto|asa\b|adaptive security|srx|firewall|checkpoint|gaia)\b/i, 'firewall'],
  [/\b(rack ?pdu|pdu|power distribution|raritan|servertech|apc .*switched)\b/i, 'pdu'],
  [/\b(ups|smart-ups|symmetra|eaton 9px|galaxy)\b/i, 'ups'],
  [/\b(netapp|ontap|data ontap|purity|powerstore|unity|isilon|storage)\b/i, 'storage_array'],
  [/\b(f5|big-?ip|netscaler|citrix adc|a10)\b/i, 'load_balancer'],
  [/\b(ios xr|ios-xr|asr|isr|routeros|mikrotik|junos.*\bmx\d|vyos|router)\b/i, 'router'],
  [/\b(switch|catalyst|nexus|nx-os|arista|eos|junos.*\bex\d|qfx|procurve|aruba|dell emc networking|cumulus|sonic)\b/i, 'switch'],
  [/\b(linux|windows|freebsd|vmware esxi)\b/i, 'physical_server'],
];

/** Best guess for new assets only; a matched asset's type is never overwritten. */
export function inferType(facts: Pick<ParsedHostFacts, 'protocol' | 'sysDescr' | 'isVirtual' | 'model' | 'vendor'>): AssetType {
  if (facts.isVirtual) return 'virtual_machine';
  if (facts.protocol === 'ssh') return 'physical_server';
  const text = [facts.sysDescr, facts.vendor, facts.model].filter(Boolean).join(' ');
  return SNMP_TYPES.find(([re]) => re.test(text))?.[1] ?? 'other';
}

export const assetNameFor = (facts: Pick<ParsedHostFacts, 'hostname' | 'ip'>) => {
  const h = facts.hostname?.trim();
  // FQDNs make long rack labels; keep the host part, the FQDN stays in the discovery facts.
  return h ? (/^\d+\.\d+\.\d+\.\d+$/.test(h) ? h : h.split('.')[0]) : facts.ip;
};

/**
 * MACs that do not identify one machine: zero/broadcast, multicast, and the virtual-router
 * ranges (VRRP 00:00:5e:00:01/02, HSRP 00:00:0c:07:ac / 00:00:0c:9f:f, GLBP 00:07:b4) that
 * every member of a router pair answers with.
 */
export function isIdentityMac(mac: string): boolean {
  const m = mac.toLowerCase();
  if (m === '00:00:00:00:00:00' || m === 'ff:ff:ff:ff:ff:ff') return false;
  if (parseInt(m.slice(0, 2), 16) & 1) return false;
  return !/^(00:00:5e:00:0[12]|00:00:0c:07:ac|00:00:0c:9f:f|00:07:b4:0)/.test(m);
}

/** Ephemeral range start used when the far side never told us what it listens on (IANA 49152; Linux 32768). */
const EPHEMERAL_FLOOR = 32768;
const NON_ROUTABLE = /^(0\.|169\.254\.|::$|fe80:|ff[0-9a-f]{2}:|22[4-9]\.|23\d\.)/i;
const LOOPBACK = /^(127\.|::1$)/;

export interface Outbound {
  remoteIp: string;
  ports: number[];
  process: string | null;
}

/**
 * Client-side sessions of a host: the local port is not one of its own listeners.
 * Loopback, link-local, multicast and the host's own address are dropped; sessions are grouped per remote IP.
 */
export function outboundDependencies(facts: Pick<ParsedHostFacts, 'ip' | 'listeners' | 'connections'>): Outbound[] {
  const own = new Set(facts.listeners.map((l) => l.port));
  const byIp = new Map<string, { ports: Set<number>; processes: Map<string, number> }>();
  for (const c of facts.connections) {
    // Loopback peers are the host talking to itself, unless the host was itself reached on loopback (the lab simulator).
    const loopback = LOOPBACK.test(c.remoteIp) && !LOOPBACK.test(facts.ip);
    if (own.has(c.localPort) || NON_ROUTABLE.test(c.remoteIp) || loopback || c.remoteIp === facts.ip) continue;
    const e = byIp.get(c.remoteIp) ?? { ports: new Set(), processes: new Map() };
    e.ports.add(c.remotePort);
    if (c.process) e.processes.set(c.process, (e.processes.get(c.process) ?? 0) + 1);
    byIp.set(c.remoteIp, e);
  }
  return [...byIp].map(([remoteIp, e]) => ({
    remoteIp,
    ports: [...e.ports].sort((a, b) => a - b),
    process: [...e.processes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null,
  }));
}

/**
 * Which of the remote ports are real services. If the remote host reported its listeners, trust
 * them exactly; otherwise drop ports in the ephemeral range (the far side of an inbound session).
 */
export function servicePorts(ports: number[], remoteListeners: number[] | null): number[] {
  if (remoteListeners) {
    const l = new Set(remoteListeners);
    return ports.filter((p) => l.has(p));
  }
  return ports.filter((p) => p < EPHEMERAL_FLOOR);
}
