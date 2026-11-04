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
