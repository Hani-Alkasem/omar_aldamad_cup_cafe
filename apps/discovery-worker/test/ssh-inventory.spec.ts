import { parseInventory } from '../src/collectors/ssh-inventory';

const OUT = `@@hostname
web-07.dc.example.com
@@uuid
4C4C4544-0042-3510-8051-B4C04F4B4E32
@@serial
7XKQ4N3
@@vendor
Dell Inc.
@@product
PowerEdge R660
@@virt
none
@@os
Ubuntu 24.04.1 LTS
@@cpus
64
@@mem
MemTotal:       263842716 kB
@@disks
NAME="nvme0n1" SIZE="1920383410176" TYPE="disk" MODEL="Dell Ent NVMe CM6 RI 1.92TB"
NAME="loop0" SIZE="67108864" TYPE="loop" MODEL=""
NAME="sr0" SIZE="1073741312" TYPE="rom" MODEL="Virtual CDROM"
@@links
lo 00:00:00:00:00:00 
eno1 3c:ec:ef:10:20:30 25000
eno2 3c:ec:ef:10:20:31 -1
docker0 02:42:ac:11:00:01 
@@end
`;

describe('parseInventory', () => {
  it('extracts identity, hardware and interfaces', () => {
    const f = parseInventory('10.0.0.5', OUT, 'SHA256:abc');
    expect(f).toMatchObject({
      hostname: 'web-07.dc.example.com',
      systemUuid: '4c4c4544-0042-3510-8051-b4c04f4b4e32',
      serialNumber: '7XKQ4N3',
      vendor: 'Dell Inc.',
      model: 'PowerEdge R660',
      os: 'Ubuntu 24.04.1 LTS',
      isVirtual: false,
      cpuCores: 64,
      memoryGb: 251.6,
      disks: [{ name: 'nvme0n1', sizeGb: 1920, model: 'Dell Ent NVMe CM6 RI 1.92TB' }],
      interfaces: [{ name: 'eno1', mac: '3c:ec:ef:10:20:30', speedMbps: 25000 }, { name: 'eno2', mac: '3c:ec:ef:10:20:31' }],
      sshHostKey: 'SHA256:abc',
    });
  });

  it('drops placeholder serials and UUIDs, detects VMs, survives missing sections', () => {
    const vm = OUT.replace('7XKQ4N3', 'To be filled by O.E.M.')
      .replace('4C4C4544-0042-3510-8051-B4C04F4B4E32', '03000200-0400-0500-0006-000700080009')
      .replace('@@virt\nnone', '@@virt\nkvm');
    const f = parseInventory('10.0.0.6', vm);
    expect(f.serialNumber).toBeUndefined();
    expect(f.systemUuid).toBeUndefined();
    expect(f.isVirtual).toBe(true);
    expect(parseInventory('10.0.0.7', '@@hostname\nbox\n@@end\n')).toMatchObject({ hostname: 'box', disks: [], interfaces: [] });
  });
});

import { parseSockets } from '../src/collectors/ssh-inventory';

describe('parseSockets', () => {
  it('reads ss output: listeners, client-side sessions deduped per endpoint', () => {
    const listen = [
      '0      4096        0.0.0.0:5432        0.0.0.0:*    users:(("postgres",pid=812,fd=6))',
      '0      128            [::]:22             [::]:*    users:(("sshd",pid=701,fd=4))',
      '0      128         0.0.0.0:22          0.0.0.0:*',
    ];
    const est = [
      '0      0        10.0.0.5:51234     10.0.0.9:5432  users:(("java",pid=1200,fd=33))',
      '0      0        10.0.0.5:51236     10.0.0.9:5432  users:(("java",pid=1200,fd=34))',
      '0      0   [::ffff:10.0.0.5]:5432 [::ffff:10.0.0.7]:40112',
      '0      0        10.0.0.5:22        10.9.9.9:60001',
    ];
    const r = parseSockets(listen, est);
    expect(r.listeners).toEqual([{ port: 22, process: 'sshd' }, { port: 5432, process: 'postgres' }]);
    // Two pooled sessions to 10.0.0.9:5432 collapse into one; inbound sessions are kept for the API to classify.
    expect(r.connections).toEqual([
      { remoteIp: '10.0.0.9', remotePort: 5432, localPort: 51234, process: 'java' },
      { remoteIp: '10.0.0.7', remotePort: 40112, localPort: 5432 },
      { remoteIp: '10.9.9.9', remotePort: 60001, localPort: 22 },
    ]);
  });

  it('reads netstat output as a fallback', () => {
    const r = parseSockets(
      ['tcp        0      0 0.0.0.0:3306            0.0.0.0:*               LISTEN      950/mysqld'],
      ['tcp        0      0 10.0.0.8:44120          10.0.0.20:443           ESTABLISHED 2001/curl'],
    );
    expect(r.listeners).toEqual([{ port: 3306, process: 'mysqld' }]);
    expect(r.connections).toEqual([{ remoteIp: '10.0.0.20', remotePort: 443, localPort: 44120, process: 'curl' }]);
  });
});
