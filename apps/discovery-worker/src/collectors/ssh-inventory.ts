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
  // Sockets: ss (iproute2) first, netstat (net-tools) on older systems. Process names need privileges; they are optional.
  "echo '@@listen'; ss -Htanp state listening 2>/dev/null || netstat -tlnp 2>/dev/null",
  "echo '@@conns'; ss -Htanp state established 2>/dev/null || netstat -tnp 2>/dev/null | grep ESTABLISHED",
  "echo '@@end'",
].join('\n');

const MAX_LISTENERS = 512;
const MAX_CONNECTIONS = 4096;

/** "0.0.0.0:5432", "[::]:22", "*:80", "[::ffff:10.0.0.9]:5432" → { ip, port } */
function endpoint(text: string): { ip: string; port: number } | undefined {
  const i = text.lastIndexOf(':');
  if (i < 0) return undefined;
  const port = Number(text.slice(i + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const ip = text.slice(0, i).replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '').replace(/%.*$/, '');
  return { ip, port };
}

/** users:(("postgres",pid=812,fd=6)) or 812/postgres */
const processOf = (text: string | undefined) => /users:\(\("([^"]+)"/.exec(text ?? '')?.[1] ?? /^\d+\/([^\s]+)/.exec(text ?? '')?.[1];

/** One socket line from ss (-H, state filter: Recv-Q Send-Q Local Peer Process) or netstat (Proto Recv-Q Send-Q Local Foreign State PID/Program). */
export function parseSocketLine(line: string) {
  const f = line.trim().split(/\s+/);
  if (f[0] === 'tcp' || f[0] === 'tcp6') {
    const local = endpoint(f[3] ?? '');
    const peer = endpoint(f[4] ?? '');
    return local ? { local, peer, process: processOf(f[6]) } : undefined;
  }
  if (f.length < 4 || !/^\d+$/.test(f[0])) return undefined;
  const local = endpoint(f[2]);
  return local ? { local, peer: endpoint(f[3]), process: processOf(f.slice(4).join(' ')) } : undefined;
}

export function parseSockets(listenLines: string[], connLines: string[]) {
  const listeners = new Map<number, string | undefined>();
  for (const l of listenLines) {
    const s = parseSocketLine(l);
    if (s && listeners.size < MAX_LISTENERS && !listeners.has(s.local.port)) listeners.set(s.local.port, s.process);
  }
  // Many sessions share one dependency (connection pools); one entry per remote endpoint and process.
  const conns = new Map<string, { remoteIp: string; remotePort: number; localPort: number; process?: string }>();
  for (const l of connLines) {
    const s = parseSocketLine(l);
    if (!s?.peer) continue;
    const key = `${s.peer.ip}|${s.peer.port}|${s.process ?? ''}|${listeners.has(s.local.port) ? s.local.port : 'out'}`;
    if (!conns.has(key) && conns.size < MAX_CONNECTIONS) {
      conns.set(key, { remoteIp: s.peer.ip, remotePort: s.peer.port, localPort: s.local.port, ...(s.process ? { process: s.process.slice(0, 64) } : {}) });
    }
  }
  return {
    listeners: [...listeners].sort((a, b) => a[0] - b[0]).map(([port, process]) => ({ port, ...(process ? { process: process.slice(0, 64) } : {}) })),
    connections: [...conns.values()],
  };
}

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
    ...parseSockets(s('listen'), s('conns')),
    ...(sshHostKey ? { sshHostKey } : {}),
  };
}
