import type { CredentialSecret, DiscoveryOptions, HostFacts } from '@itam/shared';

export type Credential = CredentialSecret & { id: string; name: string; username: string | null };

export type ProbeResult =
  | { kind: 'facts'; facts: HostFacts }
  /** The host answered and rejected this credential: try the next one. */
  | { kind: 'auth_failed'; message: string }
  /** Nothing listening, or (SNMPv2c) a wrong community, which is indistinguishable from silence. */
  | { kind: 'unreachable' }
  | { kind: 'error'; message: string };

export interface Collector {
  probe(ip: string, credential: Credential, options: DiscoveryOptions): Promise<ProbeResult>;
}

const JUNK_SERIAL = /^(0+|none|n\/a|not specified|not applicable|to be filled by o\.e\.m\.?|system serial number|default string|chassis serial number|123456789|unknown|\s*)$/i;
/** DMI and ENTITY-MIB are full of placeholder serials; a placeholder must never become an identity key. */
export const cleanSerial = (s?: string | null) => {
  const t = s?.trim();
  return t && !JUNK_SERIAL.test(t) ? t : undefined;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Reject malformed and well-known placeholder SMBIOS UUIDs. */
export const cleanUuid = (s?: string | null) => {
  const t = s?.trim().toLowerCase();
  if (!t || !UUID.test(t)) return undefined;
  if (/^0{8}-0{4}-0{4}-0{4}-0{12}$|^f{8}-f{4}-f{4}-f{4}-f{12}$|^03000200-0400-0500-0006-000700080009$/.test(t)) return undefined;
  return t;
};
