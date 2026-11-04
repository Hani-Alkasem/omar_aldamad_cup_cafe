import type { HostFacts } from '@itam/shared';
import { cleanSerial, cleanUuid } from './types';

/**
 * One read-only POSIX sh script, one exec. No writes, no package managers, no root required:
 * DMI fields fall back to passwordless `sudo -n` and are simply absent when that is not allowed.
 */
export const INVENTORY_SCRIPT = [
  "dmi() { cat \"/sys/class/dmi/id/$1\" 2>/dev/null || sudo -n cat \"/sys/class/dmi/id/$1\" 2>/dev/null; }",
  "echo '@@hostname'; hostname -f 2>/dev/null || hostname",
  "echo '@@uuid'; dmi product_uuid",
  "echo '@@serial'; dmi product_serial",
  "echo '@@vendor'; dmi sys_vendor",
  "echo '@@product'; dmi product_name",
  "echo '@@virt'; systemd-detect-virt 2>/dev/null",
  "echo '@@os'; ( . /etc/os-release 2>/dev/null && echo \"$PRETTY_NAME\" ) || uname -sr",
  "echo '@@cpus'; nproc 2>/dev/null || getconf _NPROCESSORS_ONLN",
  "echo '@@mem'; grep MemTotal /proc/meminfo 2>/dev/null",
  "echo '@@disks'; lsblk -dbnPo NAME,SIZE,TYPE,MODEL 2>/dev/null",
  "echo '@@links'; for i in /sys/class/net/*; do n=${i##*/}; printf '%s %s %s\\n' \"$n\" \"$(cat \"$i/address\" 2>/dev/null)\" \"$(cat \"$i/speed\" 2>/dev/null)\"; done",
  "echo '@@end'",
].join('\n');

const VIRTUAL_PRODUCT = /\b(vmware|virtualbox|kvm|qemu|virtual machine|hvm domu|bochs|xen|openstack nova|google compute engine|amazon ec2)\b/i;
/** Interfaces that never identify hardware. */
const SKIP_IFACE = /^(lo|docker\d*|br-[0-9a-f]+|veth.*|virbr\d+.*|cni\d*|flannel.*|cali.*|tun\d+|tap\d+|wg\d+|kube-.*|lxc.*)$/;

function sections(out: string) {
  const map = new Map<string, string[]>();
  let cur: string[] | undefined;
  for (const line of out.split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) map.set(m[1], (cur = []));
    else cur?.push(line.replace(/\r$/, ''));
  }
  return (k: string) => (map.get(k) ?? []).filter((l) => l.trim() !== '');
}

const first = (lines: string[]) => lines[0]?.trim() || undefined;

/** lsblk -P prints KEY="value" pairs. */
const pairs = (line: string) => Object.fromEntries([...line.matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2].trim()]));

export function parseInventory(ip: string, out: string, sshHostKey?: string): HostFacts {
  const s = sections(out);
  const product = first(s('product'));
  const virt = first(s('virt'));
  const memKb = Number(/MemTotal:\s+(\d+)\s*kB/.exec(s('mem').join(' '))?.[1] ?? NaN);
  const cpus = Number(first(s('cpus')));

  const disks = s('disks')
    .map(pairs)
    .filter((d) => d.TYPE === 'disk' && Number(d.SIZE) > 0 && !/^(loop|ram|zram|sr)\d*/.test(d.NAME ?? ''))
    .map((d) => ({ name: d.NAME, sizeGb: Math.round(Number(d.SIZE) / 1e9), ...(d.MODEL ? { model: d.MODEL } : {}) }));

  const interfaces = s('links')
    .map((l) => l.trim().split(/\s+/))
    .filter(([name]) => name && !SKIP_IFACE.test(name))
    .map(([name, mac, speed]) => {
      const sp = Number(speed);
      return {
        name,
        ...(mac && /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i.test(mac) && mac !== '00:00:00:00:00:00' ? { mac: mac.toLowerCase() } : {}),
        ...(Number.isInteger(sp) && sp > 0 ? { speedMbps: sp } : {}),
      };
    });

  return {
    ip,
    protocol: 'ssh',
    hostname: first(s('hostname')),
    systemUuid: cleanUuid(first(s('uuid'))),
    serialNumber: cleanSerial(first(s('serial'))),
    vendor: first(s('vendor')),
    model: product,
    os: first(s('os')),
    isVirtual: Boolean((virt && virt !== 'none') || (product && VIRTUAL_PRODUCT.test(product))),
    ...(Number.isInteger(cpus) && cpus > 0 ? { cpuCores: cpus } : {}),
    ...(memKb > 0 ? { memoryGb: Math.round((memKb / 1024 / 1024) * 10) / 10 } : {}),
    disks,
    interfaces,
    ...(sshHostKey ? { sshHostKey } : {}),
  };
}
