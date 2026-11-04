import { HostFactsSchema } from '@itam/shared';
import { assetNameFor, inferType, resolveIdentity, type KnownAsset, type Lookups } from './reconcile';

const facts = (f: Record<string, unknown>) => HostFactsSchema.parse({ ip: '10.0.0.5', protocol: 'ssh', ...f });
const asset = (id: string, extra: Partial<KnownAsset> = {}): KnownAsset => ({ id, name: id, serialNumber: null, systemUuid: null, sshHostKey: null, ...extra });
const none: Lookups = { bySystemUuid: [], bySerial: [], byMac: [], byIp: [] };
const U1 = '4c4c4544-0000-1000-8000-000000000001';
const KEY_A = `SHA256:${'A'.repeat(43)}`;
const KEY_B = `SHA256:${'B'.repeat(43)}`;

describe('resolveIdentity', () => {
  it('creates when nothing matches', () => {
    expect(resolveIdentity(facts({}), none).kind).toBe('create');
  });

  it('prefers the strongest key that hit', () => {
    const a = asset('a');
    expect(resolveIdentity(facts({ systemUuid: U1 }), { ...none, bySystemUuid: [a], byMac: [a] })).toMatchObject({ kind: 'match', matchedBy: 'system_uuid' });
    expect(resolveIdentity(facts({}), { ...none, byMac: [a] })).toMatchObject({ kind: 'match', matchedBy: 'mac' });
  });

  it('flags hardware keys that disagree', () => {
    const m = resolveIdentity(facts({}), { ...none, bySerial: [asset('a')], byMac: [asset('b')] });
    expect(m).toMatchObject({ kind: 'conflict', candidates: [{ id: 'a', via: 'serial' }, { id: 'b', via: 'mac' }] });
  });

  it('uses IP only when the asset there is not a different machine', () => {
    expect(resolveIdentity(facts({ serialNumber: 'S1' }), { ...none, byIp: [asset('a')] })).toMatchObject({ kind: 'match', matchedBy: 'ip' });
    expect(resolveIdentity(facts({ serialNumber: 'S1' }), { ...none, byIp: [asset('a', { serialNumber: 'OTHER' })] }).kind).toBe('create');
  });

  it('refuses a match whose stored serial differs (NIC moved)', () => {
    const m = resolveIdentity(facts({ serialNumber: 'NEW' }), { ...none, byMac: [asset('a', { serialNumber: 'OLD' })] });
    expect(m).toMatchObject({ kind: 'conflict' });
  });

  it('flags a changed SSH host key, accepts the same one', () => {
    const a = asset('a', { sshHostKey: KEY_A });
    expect(resolveIdentity(facts({ sshHostKey: KEY_B }), { ...none, byMac: [a] })).toMatchObject({ kind: 'conflict', reason: expect.stringMatching(/host key changed/) });
    expect(resolveIdentity(facts({ sshHostKey: KEY_A }), { ...none, byMac: [a] }).kind).toBe('match');
  });
});

describe('inferType and naming', () => {
  it.each([
    ['Arista Networks EOS version 4.31.1F running on an Arista DCS-7050SX3', 'switch'],
    ['Cisco IOS XR Software, ASR9K', 'router'],
    ['FortiGate-100F v7.2.5', 'firewall'],
    ['APC Web/SNMP Management Card (MB:v4.4.2) AP8881 Rack PDU', 'pdu'],
    ['NetApp Release 9.13.1P2: ONTAP', 'storage_array'],
    ['Linux web-01 6.8.0-45-generic #45-Ubuntu SMP x86_64', 'physical_server'],
    ['Some appliance', 'other'],
  ])('%s → %s', (sysDescr, type) => {
    expect(inferType({ protocol: 'snmp', sysDescr })).toBe(type);
  });

  it('virtual machines win over protocol', () => {
    expect(inferType({ protocol: 'ssh', isVirtual: true })).toBe('virtual_machine');
  });

  it('shortens FQDNs, falls back to the IP', () => {
    expect(assetNameFor({ hostname: 'web-01.dc.example.com', ip: '10.0.0.5' })).toBe('web-01');
    expect(assetNameFor({ ip: '10.0.0.5' })).toBe('10.0.0.5');
  });
});

import { isIdentityMac } from './reconcile';
describe('isIdentityMac', () => {
  it.each([
    ['3c:ec:ef:12:34:56', true],
    ['00:00:00:00:00:00', false],
    ['01:00:5e:00:00:fb', false],
    ['00:00:5e:00:01:0a', false],
    ['00:00:0c:07:ac:01', false],
  ])('%s → %s', (mac, ok) => expect(isIdentityMac(mac)).toBe(ok));
});
