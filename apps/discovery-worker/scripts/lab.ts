/**
 * Lab simulator for demos and local end-to-end runs. No real network gear needed.
 *
 *   SSH on 0.0.0.0:2222. Linux routes all of 127.0.0.0/8 to loopback, so 127.0.0.11-13 are three
 *     "servers", each with its own identity (chosen by the local address the client dialled).
 *     Login: discovery / lab-password.
 *   SNMP v2c on 127.0.0.20:1161, community lab-ro: one Arista switch.
 *
 * pnpm --filter @itam/discovery-worker lab
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import snmp from 'net-snmp';
import { Server, utils } from 'ssh2';

/** Canned `ss` output: app-01 and app-02 use PostgreSQL on build-vm-07, app-01 also talks to the switch's HTTPS API. */
const SOCKETS: Record<string, { listen: string[]; conns: string[] }> = {
  '127.0.0.11': {
    listen: ['0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=701,fd=3))', '0 4096 0.0.0.0:8080 0.0.0.0:* users:(("java",pid=1201,fd=40))'],
    conns: ['0 0 127.0.0.11:51234 127.0.0.13:5432 users:(("java",pid=1201,fd=51))', '0 0 127.0.0.11:51236 127.0.0.13:5432 users:(("java",pid=1201,fd=52))', '0 0 127.0.0.11:44310 127.0.0.20:443 users:(("python3",pid=1500,fd=7))', '0 0 127.0.0.11:8080 127.0.0.99:53001'],
  },
  '127.0.0.12': {
    listen: ['0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=702,fd=3))', '0 4096 0.0.0.0:8080 0.0.0.0:* users:(("java",pid=1202,fd=40))'],
    conns: ['0 0 127.0.0.12:40122 127.0.0.13:5432 users:(("java",pid=1202,fd=51))'],
  },
  '127.0.0.13': {
    listen: ['0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=703,fd=3))', '0 244 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=900,fd=6))'],
    conns: ['0 0 127.0.0.13:5432 127.0.0.11:51234 users:(("postgres",pid=990,fd=9))', '0 0 127.0.0.13:5432 127.0.0.12:40122 users:(("postgres",pid=991,fd=9))'],
  },
};

const HOSTS: Record<string, { name: string; uuid: string; serial: string; cpus: number; memKb: number; mac: string; product: string; virt: string }> = {
  '127.0.0.11': { name: 'app-01.lab.example.com', uuid: '4c4c4544-0031-3210-8051-b4c04f4b4e01', serial: 'LAB0001', cpus: 32, memKb: 131_072_000, mac: '3c:ec:ef:00:00:11', product: 'PowerEdge R660', virt: 'none' },
  '127.0.0.12': { name: 'app-02.lab.example.com', uuid: '4c4c4544-0031-3210-8051-b4c04f4b4e02', serial: 'LAB0002', cpus: 32, memKb: 131_072_000, mac: '3c:ec:ef:00:00:12', product: 'PowerEdge R660', virt: 'none' },
  '127.0.0.13': { name: 'build-vm-07.lab.example.com', uuid: '564d2b5e-8c1a-4f3e-9d2a-1b2c3d4e5f60', serial: 'VMware-56 4d 2b 5e', cpus: 8, memKb: 16_384_000, mac: '00:50:56:aa:00:13', product: 'VMware Virtual Platform', virt: 'vmware' },
};

function inventory(ip: string, h: (typeof HOSTS)[string]) {
  const sock = SOCKETS[ip] ?? { listen: [], conns: [] };
  return [
    '@@hostname', h.name, '@@uuid', h.uuid, '@@serial', h.serial, '@@vendor', h.virt === 'none' ? 'Dell Inc.' : 'VMware, Inc.',
    '@@product', h.product, '@@virt', h.virt, '@@os', 'Ubuntu 24.04.1 LTS', '@@cpus', String(h.cpus), '@@mem', `MemTotal: ${h.memKb} kB`,
    '@@disks', 'NAME="nvme0n1" SIZE="960197124096" TYPE="disk" MODEL="Dell Ent NVMe"', '@@links', 'lo 00:00:00:00:00:00 ', `eno1 ${h.mac} 25000`, '@@listen', ...sock.listen, '@@conns', ...sock.conns, '@@end', '',
  ].join('\n');
}

// Stable across restarts: a new key every start would (correctly) be flagged as a host key change.
const keyFile = join(tmpdir(), 'itam-lab-ssh-host-key');
if (!existsSync(keyFile)) writeFileSync(keyFile, utils.generateKeyPairSync('ed25519').private, { mode: 0o600 });
const hostKey = { private: readFileSync(keyFile, 'utf8') };
const ssh = new Server({ hostKeys: [hostKey.private] }, (client) => {
  // ssh2 exposes the underlying socket; its local address tells us which "host" was dialled.
  const sock = (client as unknown as { _sock?: { localAddress?: string; destroy(): void } })._sock;
  const local = (sock?.localAddress ?? '').replace(/^::ffff:/, '');
  // Addresses with no simulated host behave like a machine with nothing on port 22.
  if (!HOSTS[local]) return sock?.destroy();
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'discovery' && ctx.password === 'lab-password' ? ctx.accept() : ctx.reject(['password'])));
  client.on('ready', () => {
    client.on('session', (accept) =>
      accept().on('exec', (acc) => {
        const s = acc();
        const h = HOSTS[local];
        if (h) s.write(inventory(local, h));
        s.exit(h ? 0 : 1);
        s.end();
      }),
    );
  });
  client.on('error', () => undefined);
});
ssh.listen(2222, '0.0.0.0', () => console.log('lab ssh on :2222 for', Object.keys(HOSTS).join(', ')));

const agent = snmp.createAgent({ port: 1161, address: '127.0.0.20', disableAuthorization: false }, () => undefined);
agent.getAuthorizer().addCommunity('lab-ro');
const mib = agent.getMib();
const RO = snmp.MaxAccess['read-only'];
for (const [name, oid, type, value] of [
  ['sysDescr', '1.3.6.1.2.1.1.1', snmp.ObjectType.OctetString, 'Arista Networks EOS version 4.31.1F running on an Arista DCS-7050SX3-48YC8'],
  ['sysObjectID', '1.3.6.1.2.1.1.2', snmp.ObjectType.OID, '1.3.6.1.4.1.30065.1.3011.7050.3741.48'],
  ['sysName', '1.3.6.1.2.1.1.5', snmp.ObjectType.OctetString, 'lab-leaf-01'],
] as const) {
  mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: RO });
  mib.setScalarValue(name, value);
}
mib.registerProvider({
  name: 'ifEntry', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.2.2.1', maxAccess: snmp.MaxAccess['not-accessible'],
  tableColumns: [[1, 'ifIndex', snmp.ObjectType.Integer], [2, 'ifDescr', snmp.ObjectType.OctetString], [5, 'ifSpeed', snmp.ObjectType.Gauge], [6, 'ifPhysAddress', snmp.ObjectType.OctetString]].map(([number, name, type]) => ({ number, name, type, maxAccess: RO })),
  tableIndex: [{ columnName: 'ifIndex' }],
});
for (let i = 1; i <= 4; i++) mib.addTableRow('ifEntry', [i, `Ethernet${i}`, 1_000_000_000, Buffer.from([0x44, 0x4c, 0xa8, 0, 0x20, i])]);
mib.registerProvider({
  name: 'entPhysicalEntry', type: snmp.MibProviderType.Table, oid: '1.3.6.1.2.1.47.1.1.1.1', maxAccess: snmp.MaxAccess['not-accessible'],
  tableColumns: [[1, 'entPhysicalIndex', snmp.ObjectType.Integer], [5, 'entPhysicalClass', snmp.ObjectType.Integer], [11, 'entPhysicalSerialNum', snmp.ObjectType.OctetString], [13, 'entPhysicalModelName', snmp.ObjectType.OctetString]].map(([number, name, type]) => ({ number, name, type, maxAccess: RO })),
  tableIndex: [{ columnName: 'entPhysicalIndex' }],
});
mib.addTableRow('entPhysicalEntry', [1, 3, 'JPE2200LAB1', 'DCS-7050SX3-48YC8']);
console.log('lab snmp on 127.0.0.20:1161 (community lab-ro)');
