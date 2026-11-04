import { createSocket } from 'node:dgram';
import snmp from 'net-snmp';
import { SnmpCollector } from '../src/collectors/snmp';
import type { Credential } from '../src/collectors/types';

async function freeUdpPort() {
  const s = createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

let agent: snmp.Agent;
let port: number;
const RO = snmp.MaxAccess['read-only'];

beforeAll(async () => {
  port = await freeUdpPort();
  agent = snmp.createAgent({ port, address: '127.0.0.1', disableAuthorization: false }, () => undefined);
  const auth = agent.getAuthorizer();
  auth.addCommunity('lab-ro');
  auth.addUser({ name: 'itam', level: snmp.SecurityLevel.authPriv, authProtocol: snmp.AuthProtocols.sha256, authKey: 'auth-key-123', privProtocol: snmp.PrivProtocols.aes, privKey: 'priv-key-123' });
  const mib = agent.getMib();
  const scalar = (name: string, oid: string, type: number, value: unknown) => {
    mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO });
    mib.setScalarValue(name, value);
  };
  scalar('sysDescr', '1.3.6.1.2.1.1.1', snmp.ObjectType.OctetString, 'Arista Networks EOS version 4.31.1F running on an Arista DCS-7050SX3-48YC8');
  scalar('sysObjectID', '1.3.6.1.2.1.1.2', snmp.ObjectType.OID, '1.3.6.1.4.1.30065.1.3011.7050.3741.48');
  scalar('sysName', '1.3.6.1.2.1.1.5', snmp.ObjectType.OctetString, 'core-sw-09');

  const table = (name: string, oid: string, columns: Array<[number, string, number]>, rows: unknown[][]) => {
    mib.registerProvider({
      name,
      type: snmp.MibProviderType.Table,
      oid,
      maxAccess: snmp.MaxAccess['not-accessible'],
      tableColumns: columns.map(([number, cname, type]) => ({ number, name: cname, type, maxAccess: RO })),
      tableIndex: [{ columnName: columns[0][1] }],
    });
    for (const r of rows) mib.addTableRow(name, r);
  };
  const mac = (s: string) => Buffer.from(s.split(':').map((h) => parseInt(h, 16)));
  table('ifEntry', '1.3.6.1.2.1.2.2.1', [[1, 'ifIndex', snmp.ObjectType.Integer], [2, 'ifDescr', snmp.ObjectType.OctetString], [5, 'ifSpeed', snmp.ObjectType.Gauge], [6, 'ifPhysAddress', snmp.ObjectType.OctetString]], [
    [1, 'Ethernet1', 4294967295, mac('44:4c:a8:01:02:03')],
    [2, 'Management1', 1000000000, mac('44:4c:a8:01:02:04')],
  ]);
  table('ifXEntry', '1.3.6.1.2.1.31.1.1.1', [[1, 'ifName', snmp.ObjectType.OctetString], [15, 'ifHighSpeed', snmp.ObjectType.Gauge]], []);
  table('entPhysicalEntry', '1.3.6.1.2.1.47.1.1.1.1', [[1, 'entPhysicalIndex', snmp.ObjectType.Integer], [5, 'entPhysicalClass', snmp.ObjectType.Integer], [11, 'entPhysicalSerialNum', snmp.ObjectType.OctetString], [12, 'entPhysicalMfgName', snmp.ObjectType.OctetString], [13, 'entPhysicalModelName', snmp.ObjectType.OctetString]], [
    [1, 3, 'JPE21384567', 'Arista Networks', 'DCS-7050SX3-48YC8'],
    [100, 10, 'PSU-SERIAL', 'Arista Networks', 'PWR-500AC'],
  ]);
});

afterAll(() => new Promise<void>((r) => agent.close(() => r())));

const opts = () => ({ timeoutMs: 800, tlsInsecure: false, concurrency: 1, port });
const v2c = (community: string): Credential => ({ id: 'c1', name: 'v2c', kind: 'snmp_v2c', username: null, secret: { community } });

describe('SnmpCollector', () => {
  it('collects the system group, interfaces with MACs and speeds, and the chassis serial', async () => {
    const r = await new SnmpCollector().probe('127.0.0.1', v2c('lab-ro'), opts());
    expect(r).toMatchObject({
      kind: 'facts',
      facts: {
        protocol: 'snmp',
        hostname: 'core-sw-09',
        vendor: 'Arista Networks',
        model: 'DCS-7050SX3-48YC8',
        serialNumber: 'JPE21384567',
        sysObjectId: '1.3.6.1.4.1.30065.1.3011.7050.3741.48',
        interfaces: [
          { name: 'Ethernet1', mac: '44:4c:a8:01:02:03' },
          { name: 'Management1', mac: '44:4c:a8:01:02:04', speedMbps: 1000 },
        ],
      },
    });
  });

  it('works over SNMPv3 authPriv', async () => {
    const cred: Credential = { id: 'c3', name: 'v3', kind: 'snmp_v3', username: 'itam', secret: { authProtocol: 'sha256', authKey: 'auth-key-123', privProtocol: 'aes', privKey: 'priv-key-123' } };
    expect((await new SnmpCollector().probe('127.0.0.1', cred, opts())).kind).toBe('facts');
  });

  it('a wrong v2c community looks like silence', async () => {
    expect(await new SnmpCollector().probe('127.0.0.1', v2c('wrong'), opts())).toEqual({ kind: 'unreachable' });
  });
});
