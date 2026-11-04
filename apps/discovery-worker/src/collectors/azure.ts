import type { DiscoveryOptions, HostFacts } from '@itam/shared';
import { boundedTags, primaryIp, type InventoryCollector, type InventoryResult } from './inventory';
import type { Credential } from './types';

interface ArmList<T> { value: T[]; nextLink?: string }
interface ArmVm {
  id: string;
  name: string;
  location: string;
  tags?: Record<string, string>;
  properties: {
    vmId?: string;
    hardwareProfile?: { vmSize?: string };
    osProfile?: { computerName?: string };
    storageProfile?: { osDisk?: { osType?: string; name?: string; diskSizeGB?: number }; dataDisks?: Array<{ name?: string; diskSizeGB?: number }>; imageReference?: { offer?: string; sku?: string } };
    networkProfile?: { networkInterfaces?: Array<{ id: string }> };
    provisioningState?: string;
  };
}
interface ArmNic { id: string; name: string; properties: { macAddress?: string; ipConfigurations?: Array<{ properties?: { privateIPAddress?: string; primary?: boolean } }> } }

/**
 * Azure Resource Manager inventory for one subscription: VMs and their NICs, read with an Entra ID
 * app (client credentials) holding the Reader role. Sovereign clouds via apiBaseUrl/authBaseUrl.
 */
export class AzureCollector implements InventoryCollector {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async inventory(subscription: string, cred: Credential, opts: DiscoveryOptions): Promise<InventoryResult> {
    if (cred.kind !== 'azure') return { kind: 'error', message: `${cred.kind} is not an Azure credential` };
    const arm = (opts.apiBaseUrl ?? 'https://management.azure.com').replace(/\/$/, '');
    const login = (opts.authBaseUrl ?? 'https://login.microsoftonline.com').replace(/\/$/, '');
    const timeout = () => AbortSignal.timeout(Math.max(opts.timeoutMs, 15_000));

    const tokenRes = await this.fetchImpl(`${login}/${cred.secret.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cred.secret.clientId, client_secret: cred.secret.clientSecret, scope: `${arm}/.default` }),
      signal: timeout(),
    }).catch((e: Error) => e);
    if (tokenRes instanceof Error) return { kind: 'error', message: `Entra ID unreachable: ${tokenRes.message}`.slice(0, 300) };
    const tok = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string; error_description?: string };
    if (!tokenRes.ok || !tok.access_token) {
      return ['invalid_client', 'unauthorized_client', 'invalid_grant'].includes(tok.error ?? '') || tokenRes.status === 401
        ? { kind: 'auth_failed', message: 'Entra ID rejected the app credential' }
        : { kind: 'error', message: `token request failed: ${tok.error_description ?? tokenRes.status}`.slice(0, 300) };
    }

    const list = async <T>(path: string): Promise<T[]> => {
      const out: T[] = [];
      let next: string | undefined = `${arm}${path}`;
      for (let pages = 0; next && pages < 200; pages++) {
        // nextLink must stay on the ARM host; never follow it elsewhere with our token.
        if (!next.startsWith(arm)) throw new Error('unexpected nextLink host');
        const r = await this.fetchImpl(next, { headers: { authorization: `Bearer ${tok.access_token}` }, signal: timeout() });
        if (r.status === 403) throw Object.assign(new Error('the app lacks Reader on this subscription'), { auth: true });
        if (!r.ok) throw new Error(`${path.split('?')[0]} → HTTP ${r.status}`);
        const body = (await r.json()) as ArmList<T>;
        out.push(...body.value);
        next = body.nextLink;
      }
      return out;
    };

    try {
      const sub = `/subscriptions/${subscription}`;
      const [vms, nics] = await Promise.all([
        list<ArmVm>(`${sub}/providers/Microsoft.Compute/virtualMachines?api-version=2024-07-01`),
        list<ArmNic>(`${sub}/providers/Microsoft.Network/networkInterfaces?api-version=2024-05-01`),
      ]);
      const nicById = new Map(nics.map((n) => [n.id.toLowerCase(), n]));
      const hosts: HostFacts[] = vms.map((vm) => {
        const p = vm.properties;
        const myNics = (p.networkProfile?.networkInterfaces ?? []).map((r) => nicById.get(r.id.toLowerCase())).filter((n): n is ArmNic => Boolean(n));
        const ips = myNics.flatMap((n) => (n.properties.ipConfigurations ?? []).sort((a, b) => Number(b.properties?.primary) - Number(a.properties?.primary)).map((c) => c.properties?.privateIPAddress));
        const disks = [p.storageProfile?.osDisk, ...(p.storageProfile?.dataDisks ?? [])].filter((d): d is { name?: string; diskSizeGB?: number } => Boolean(d?.diskSizeGB));
        return {
          externalId: `azure:${p.vmId ?? vm.id.toLowerCase()}`,
          protocol: 'azure',
          hostname: p.osProfile?.computerName || vm.name,
          ip: primaryIp(ips),
          // Azure's vmId is the SMBIOS UUID the guest sees (byte order handled by the reconciler).
          systemUuid: p.vmId?.toLowerCase(),
          vendor: 'Microsoft Azure',
          model: p.hardwareProfile?.vmSize,
          os: [p.storageProfile?.osDisk?.osType, p.storageProfile?.imageReference?.offer, p.storageProfile?.imageReference?.sku].filter(Boolean).join(' ') || undefined,
          isVirtual: true,
          disks: disks.map((d, i) => ({ name: (d.name ?? `disk${i}`).slice(0, 64), sizeGb: d.diskSizeGB! })),
          interfaces: myNics.map((n) => ({ name: n.name.slice(0, 64), ...(n.properties.macAddress ? { mac: n.properties.macAddress.toLowerCase().replace(/-/g, ':') } : {}) })),
          cloud: { provider: 'azure', kind: 'vm', region: vm.location, account: subscription, instanceType: p.hardwareProfile?.vmSize, state: p.provisioningState },
          tags: boundedTags(vm.tags),
        };
      });
      return { kind: 'facts', hosts, warnings: [] };
    } catch (e) {
      if ((e as { auth?: boolean }).auth) return { kind: 'auth_failed', message: (e as Error).message };
      return { kind: 'error', message: (e as Error).message.slice(0, 300) };
    }
  }
}
