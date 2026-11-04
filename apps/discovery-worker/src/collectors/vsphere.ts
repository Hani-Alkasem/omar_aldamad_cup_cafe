import http from 'node:http';
import https from 'node:https';
import type { DiscoveryOptions, HostFacts } from '@itam/shared';
import { mapLimit, primaryIp, type InventoryCollector, type InventoryResult } from './inventory';
import type { Credential } from './types';

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Minimal JSON client for the vCenter REST API. Uses node:https directly so a private CA (the
 * usual on-prem case) can be pinned per job, and certificate checks can be turned off only by an
 * explicit, visible option.
 */
function requestJson<T>(url: string, init: { method?: string; headers?: Record<string, string>; ca?: string; insecure?: boolean; timeoutMs: number }): Promise<T> {
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      { method: init.method ?? 'GET', headers: { accept: 'application/json', ...init.headers }, timeout: init.timeoutMs, ...(u.protocol === 'https:' ? { ca: init.ca, rejectUnauthorized: !init.insecure } : {}) },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (body.length < 32 * 1024 * 1024 ? (body += c) : res.destroy()));
        res.on('end', () => {
          if ((res.statusCode ?? 0) >= 400) return reject(new HttpError(res.statusCode ?? 0, `${init.method ?? 'GET'} ${u.pathname} → HTTP ${res.statusCode}`));
          try {
            resolve((body ? JSON.parse(body) : null) as T);
          } catch {
            reject(new Error(`${u.pathname}: response is not JSON`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error(`${u.pathname}: no response within ${init.timeoutMs} ms`)));
    req.on('error', reject);
    req.end();
  });
}

interface VcHost { host: string; name: string; connection_state?: string; power_state?: string }
interface VcVmSummary { vm: string; name: string; power_state?: string; cpu_count?: number; memory_size_MiB?: number }
interface VcVm {
  name?: string;
  guest_OS?: string;
  identity?: { bios_uuid?: string; instance_uuid?: string; name?: string };
  cpu?: { count?: number };
  memory?: { size_MiB?: number };
  nics?: Record<string, { mac_address?: string; label?: string }>;
  disks?: Record<string, { capacity?: number; label?: string }>;
}
interface VcGuest { host_name?: string; ip_address?: string; full_name?: { default_message?: string } }

/**
 * vCenter 7.0 U2+ REST (/api): hosts, then the VMs on each host (so every VM knows its host),
 * then per-VM detail and guest identity (VMware Tools). Read-only; a role with System.View on
 * the inventory root is enough.
 */
export class VsphereCollector implements InventoryCollector {
  async inventory(endpoint: string, cred: Credential, opts: DiscoveryOptions): Promise<InventoryResult> {
    if (cred.kind !== 'vsphere') return { kind: 'error', message: `${cred.kind} is not a vSphere credential` };
    const base = endpoint.replace(/\/$/, '');
    const vc = new URL(base).host;
    const tls = { ca: opts.tlsCaPem, insecure: opts.tlsInsecure, timeoutMs: Math.max(opts.timeoutMs, 10_000) };
    let session: string;
    try {
      session = await requestJson<string>(`${base}/api/session`, { ...tls, method: 'POST', headers: { authorization: `Basic ${Buffer.from(`${cred.username}:${cred.secret.password}`).toString('base64')}` } });
    } catch (e) {
      if (e instanceof HttpError && (e.status === 401 || e.status === 403)) return { kind: 'auth_failed', message: 'vCenter rejected the credential' };
      return { kind: 'error', message: (e as Error).message.slice(0, 300) };
    }
    const get = <T>(path: string) => requestJson<T>(`${base}${path}`, { ...tls, headers: { 'vmware-api-session-id': session } });
    const warnings: string[] = opts.tlsInsecure ? ['TLS certificate checks are disabled for this vCenter'] : [];
    try {
      const hosts = await get<VcHost[]>('/api/vcenter/host');
      const facts: HostFacts[] = hosts.map((h) => ({
        externalId: `vsphere:${vc}:${h.host}`,
        protocol: 'vsphere',
        hostname: h.name,
        vendor: 'VMware',
        os: 'VMware ESXi',
        isVirtual: false,
        cloud: { provider: 'vsphere', kind: 'host', account: vc, state: h.connection_state },
        disks: [],
        interfaces: [],
      }));

      // Per host, so a VM's host is known without one call per VM.
      const placements = await mapLimit(hosts, 4, async (h) => ({ host: h, vms: await get<VcVmSummary[]>(`/api/vcenter/vm?hosts=${encodeURIComponent(h.host)}`) }));
      const vms = placements.flatMap((p) => p.vms.map((vm) => ({ vm, host: p.host })));
      const details = await mapLimit(vms, 8, async ({ vm, host }) => {
        const d = await get<VcVm>(`/api/vcenter/vm/${encodeURIComponent(vm.vm)}`).catch(() => null);
        // Guest identity needs VMware Tools running; 503/404 otherwise, which is normal.
        const g = vm.power_state === 'POWERED_ON' ? await get<VcGuest>(`/api/vcenter/vm/${encodeURIComponent(vm.vm)}/guest/identity`).catch(() => null) : null;
        return { vm, host, d, g };
      });
      for (const { vm, host, d, g } of details) {
        facts.push({
          externalId: `vsphere:${vc}:${vm.vm}`,
          runsOn: `vsphere:${vc}:${host.host}`,
          protocol: 'vsphere',
          hostname: g?.host_name || vm.name,
          ip: primaryIp([g?.ip_address]),
          systemUuid: d?.identity?.bios_uuid?.toLowerCase(),
          vendor: 'VMware',
          model: 'Virtual Machine',
          os: g?.full_name?.default_message ?? d?.guest_OS,
          isVirtual: true,
          cpuCores: d?.cpu?.count ?? vm.cpu_count,
          memoryGb: (d?.memory?.size_MiB ?? vm.memory_size_MiB ?? 0) / 1024 || undefined,
          disks: Object.values(d?.disks ?? {}).filter((x) => x.capacity).map((x, i) => ({ name: (x.label ?? `disk${i}`).slice(0, 64), sizeGb: Math.round((x.capacity ?? 0) / 1e9) })),
          interfaces: Object.values(d?.nics ?? {}).map((n, i) => ({ name: (n.label ?? `nic${i}`).slice(0, 64), ...(n.mac_address ? { mac: n.mac_address.toLowerCase() } : {}) })),
          cloud: { provider: 'vsphere', kind: 'vm', account: vc, state: vm.power_state },
        });
      }
      return { kind: 'facts', hosts: facts, warnings };
    } catch (e) {
      return { kind: 'error', message: (e as Error).message.slice(0, 300) };
    } finally {
      await requestJson(`${base}/api/session`, { ...tls, method: 'DELETE', headers: { 'vmware-api-session-id': session } }).catch(() => undefined);
    }
  }
}
