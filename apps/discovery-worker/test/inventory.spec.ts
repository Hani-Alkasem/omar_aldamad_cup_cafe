import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { DescribeInstancesCommand, DescribeInstanceTypesCommand, EC2Client } from '@aws-sdk/client-ec2';
import type { RunSpec, SubmitHostsInput } from '@itam/shared';
import { mockClient } from 'aws-sdk-client-mock';
import { AwsCollector } from '../src/collectors/aws';
import { AzureCollector } from '../src/collectors/azure';
import { primaryIp, type InventoryResult } from '../src/collectors/inventory';
import { VsphereCollector } from '../src/collectors/vsphere';
import type { Credential } from '../src/collectors/types';
import { executeRun } from '../src/run';

const opts = { timeoutMs: 2000, concurrency: 4, tlsInsecure: false };

async function serve(handler: (path: string, req: import('node:http').IncomingMessage, body: string) => { status?: number; json?: unknown }): Promise<{ url: string; server: Server; calls: string[] }> {
  const calls: string[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push(`${req.method} ${req.url}`);
      const r = handler(req.url ?? '', req, body);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
      res.end(r.json === undefined ? '' : JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server, calls };
}

describe('primaryIp', () => {
  it('skips link-local and loopback, keeps the first routable address', () => {
    expect(primaryIp(['169.254.3.4', 'fe80::1', '127.0.0.1', '10.0.0.5', '10.0.0.6'])).toBe('10.0.0.5');
    expect(primaryIp([undefined, 'not-an-ip'])).toBeUndefined();
  });
});

describe('VsphereCollector', () => {
  let vc: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    vc = await serve((path, req) => {
      if (path === '/api/session' && req.method === 'POST') {
        return req.headers.authorization === `Basic ${Buffer.from('svc-itam@vsphere.local:pw').toString('base64')}` ? { json: 'tok-1' } : { status: 401, json: { error_type: 'UNAUTHENTICATED' } };
      }
      if (req.headers['vmware-api-session-id'] !== 'tok-1' && req.method !== 'DELETE') return { status: 401 };
      if (path === '/api/session') return { status: 204 };
      if (path === '/api/vcenter/host') return { json: [{ host: 'host-10', name: 'esx01.lab', connection_state: 'CONNECTED' }, { host: 'host-11', name: 'esx02.lab', connection_state: 'CONNECTED' }] };
      if (path === '/api/vcenter/vm?hosts=host-10') return { json: [{ vm: 'vm-42', name: 'db-01', power_state: 'POWERED_ON', cpu_count: 8, memory_size_MiB: 32768 }] };
      if (path === '/api/vcenter/vm?hosts=host-11') return { json: [{ vm: 'vm-43', name: 'tmpl-ubuntu', power_state: 'POWERED_OFF' }] };
      if (path === '/api/vcenter/vm/vm-42') {
        return { json: { identity: { bios_uuid: '4223B5E8-1111-2222-3333-444455556666' }, guest_OS: 'UBUNTU_64', cpu: { count: 8 }, memory: { size_MiB: 32768 }, nics: { '4000': { label: 'Network adapter 1', mac_address: '00:50:56:AA:00:42' } }, disks: { '2000': { label: 'Hard disk 1', capacity: 107374182400 } } } };
      }
      if (path === '/api/vcenter/vm/vm-42/guest/identity') return { json: { host_name: 'db-01.lab.example.com', ip_address: '10.20.10.42', full_name: { default_message: 'Ubuntu Linux (64-bit)' } } };
      if (path === '/api/vcenter/vm/vm-43') return { json: { identity: { bios_uuid: '4223b5e8-9999-2222-3333-444455556666' } } };
      return { status: 404 };
    });
  });
  afterAll(() => new Promise<void>((r) => vc.server.close(() => r())));
  const cred = (password: string): Credential => ({ id: 'c', name: 'vc', kind: 'vsphere', username: 'svc-itam@vsphere.local', secret: { password } });

  it('returns hosts and VMs, each VM linked to its host, with guest identity when Tools runs', async () => {
    const r = await new VsphereCollector().inventory(vc.url, cred('pw'), opts);
    expect(r.kind).toBe('facts');
    if (r.kind !== 'facts') return;
    const host = new URL(vc.url).host;
    expect(r.hosts.filter((h) => h.cloud?.kind === 'host').map((h) => h.externalId)).toEqual([`vsphere:${host}:host-10`, `vsphere:${host}:host-11`]);
    expect(r.hosts.find((h) => h.externalId?.endsWith('vm-42'))).toMatchObject({
      runsOn: `vsphere:${host}:host-10`,
      hostname: 'db-01.lab.example.com',
      ip: '10.20.10.42',
      systemUuid: '4223b5e8-1111-2222-3333-444455556666',
      isVirtual: true,
      cpuCores: 8,
      memoryGb: 32,
      os: 'Ubuntu Linux (64-bit)',
      disks: [{ name: 'Hard disk 1', sizeGb: 107 }],
      interfaces: [{ name: 'Network adapter 1', mac: '00:50:56:aa:00:42' }],
    });
    // Powered-off VMs are inventoried without asking for guest identity.
    expect(vc.calls).not.toContain('GET /api/vcenter/vm/vm-43/guest/identity');
    expect(vc.calls.at(-1)).toBe('DELETE /api/session');
  });

  it('reports a rejected login as auth_failed', async () => {
    expect(await new VsphereCollector().inventory(vc.url, cred('wrong'), opts)).toMatchObject({ kind: 'auth_failed' });
  });
});

describe('AwsCollector', () => {
  const ec2 = mockClient(EC2Client);
  afterEach(() => ec2.reset());
  const cred: Credential = { id: 'c', name: 'aws', kind: 'aws', username: null, secret: { accessKeyId: 'AKIAEXAMPLEEXAMPLE12', secretAccessKey: 'x'.repeat(40) } };

  it('maps instances with sizing, NIC MACs and tags, skipping terminated ones', async () => {
    ec2.on(DescribeInstancesCommand).resolves({
      Reservations: [
        {
          OwnerId: '123456789012',
          Instances: [
            { InstanceId: 'i-0abc', InstanceType: 'm6i.large', PrivateIpAddress: '10.40.1.10', PlatformDetails: 'Linux/UNIX', State: { Name: 'running' }, CpuOptions: { CoreCount: 1, ThreadsPerCore: 2 }, Tags: [{ Key: 'Name', Value: 'api-1' }, { Key: 'aws:autoscaling:groupName', Value: 'x' }, { Key: 'env', Value: 'prod' }], NetworkInterfaces: [{ NetworkInterfaceId: 'eni-1', MacAddress: '0A:1B:2C:3D:4E:5F' }] },
            { InstanceId: 'i-0dead', State: { Name: 'terminated' } },
          ],
        },
      ],
    });
    ec2.on(DescribeInstanceTypesCommand).resolves({ InstanceTypes: [{ InstanceType: 'm6i.large', MemoryInfo: { SizeInMiB: 8192 }, VCpuInfo: { DefaultVCpus: 2 } }] });
    const r = await new AwsCollector().inventory('eu-west-1', cred, opts);
    expect(r).toMatchObject({ kind: 'facts', hosts: [{ externalId: 'aws:123456789012:eu-west-1:i-0abc', hostname: 'api-1', ip: '10.40.1.10', cpuCores: 2, memoryGb: 8, model: 'm6i.large', interfaces: [{ name: 'eni-1', mac: '0a:1b:2c:3d:4e:5f' }], tags: { Name: 'api-1', env: 'prod' }, cloud: { provider: 'aws', region: 'eu-west-1', account: '123456789012', state: 'running' } }] });
    if (r.kind === 'facts') expect(r.hosts).toHaveLength(1);
  });

  it('classifies credential errors', async () => {
    ec2.on(DescribeInstancesCommand).rejects(Object.assign(new Error('AWS was not able to validate the provided access credentials'), { name: 'AuthFailure' }));
    expect(await new AwsCollector().inventory('eu-west-1', cred, opts)).toMatchObject({ kind: 'auth_failed' });
  });
});

describe('AzureCollector', () => {
  const sub = '11111111-2222-3333-4444-555555555555';
  const tenant = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  let az: Awaited<ReturnType<typeof serve>>;
  beforeAll(async () => {
    az = await serve((path, req, body) => {
      if (path === `/${tenant}/oauth2/v2.0/token`) {
        return new URLSearchParams(body).get('client_secret') === 'right-secret' ? { json: { access_token: 'arm-token', expires_in: 3600 } } : { status: 401, json: { error: 'invalid_client' } };
      }
      if (req.headers.authorization !== 'Bearer arm-token') return { status: 401 };
      if (path.startsWith(`/subscriptions/${sub}/providers/Microsoft.Compute/virtualMachines`)) {
        return {
          json: {
            value: [{
              id: `/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/web-1`,
              name: 'web-1',
              location: 'westeurope',
              tags: { team: 'web' },
              properties: { vmId: '9F8E7D6C-5B4A-3210-FEDC-BA9876543210', hardwareProfile: { vmSize: 'Standard_D2s_v5' }, osProfile: { computerName: 'web-1' }, storageProfile: { osDisk: { osType: 'Linux', name: 'osdisk', diskSizeGB: 30 } }, networkProfile: { networkInterfaces: [{ id: `/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/web-1-nic` }] }, provisioningState: 'Succeeded' },
            }],
          },
        };
      }
      if (path.startsWith(`/subscriptions/${sub}/providers/Microsoft.Network/networkInterfaces`)) {
        return { json: { value: [{ id: `/subscriptions/${sub}/resourceGroups/rg/providers/Microsoft.Network/networkInterfaces/WEB-1-NIC`, name: 'web-1-nic', properties: { macAddress: '00-0D-3A-12-34-56', ipConfigurations: [{ properties: { privateIPAddress: '10.60.0.4', primary: true } }] } }] } };
      }
      return { status: 404 };
    });
  });
  afterAll(() => new Promise<void>((r) => az.server.close(() => r())));
  const cred = (clientSecret: string): Credential => ({ id: 'c', name: 'az', kind: 'azure', username: null, secret: { tenantId: tenant, clientId: '99999999-8888-7777-6666-555555555555', clientSecret } });
  const o = () => ({ ...opts, apiBaseUrl: az.url, authBaseUrl: az.url });

  it('joins VMs to their NICs (ids are case-insensitive) and keeps vmId as the system UUID', async () => {
    const r = await new AzureCollector().inventory(sub, cred('right-secret'), o());
    expect(r).toMatchObject({
      kind: 'facts',
      hosts: [{ externalId: 'azure:9F8E7D6C-5B4A-3210-FEDC-BA9876543210', systemUuid: '9f8e7d6c-5b4a-3210-fedc-ba9876543210', ip: '10.60.0.4', model: 'Standard_D2s_v5', interfaces: [{ name: 'web-1-nic', mac: '00:0d:3a:12:34:56' }], disks: [{ name: 'osdisk', sizeGb: 30 }], tags: { team: 'web' }, cloud: { region: 'westeurope', account: sub } }],
    });
  });

  it('reports a rejected app secret as auth_failed', async () => {
    expect(await new AzureCollector().inventory(sub, cred('wrong-secret'), o())).toMatchObject({ kind: 'auth_failed' });
  });
});

describe('inventory runs', () => {
  it('tries credentials per endpoint, batches hosts, and marks a run partial when an endpoint fails', async () => {
    const batches: SubmitHostsInput[] = [];
    let finished: unknown;
    const api = { openScheduledRun: async () => ({ id: 'r' }), claim: async () => ({}) as RunSpec, submit: async (_: string, b: SubmitHostsInput) => void batches.push(b), finish: async (_: string, b: unknown) => void (finished = b) };
    const hosts = Array.from({ length: 120 }, (_, i) => ({ externalId: `vsphere:vc:vm-${i}`, protocol: 'vsphere' as const }));
    const inventory = {
      vsphere: {
        inventory: async (endpoint: string, cred: Credential): Promise<InventoryResult> =>
          endpoint === 'https://down.example.com' ? { kind: 'error', message: 'connect ECONNREFUSED' } : cred.id === 'good' ? { kind: 'facts', hosts, warnings: [] } : { kind: 'auth_failed', message: 'no' },
      },
    };
    const spec: RunSpec = {
      runId: 'r', jobId: 'j', protocol: 'vsphere', targets: [], endpoints: ['https://vc1.example.com', 'https://down.example.com'], maxHosts: 1000,
      options: opts, leaseSeconds: 120,
      credentials: [{ id: 'bad', name: 'old', kind: 'vsphere', username: 'u', secret: { password: 'x' } }, { id: 'good', name: 'new', kind: 'vsphere', username: 'u', secret: { password: 'y' } }],
    };
    const report = await executeRun(spec, { api, collectors: {}, inventory, log: () => undefined, batchSize: 50 });
    expect(batches.filter((b) => b.hosts?.length).map((b) => b.hosts!.length)).toEqual([50, 50, 20]);
    expect(batches.flatMap((b) => b.failures ?? [])).toEqual([{ ip: 'https://down.example.com', outcome: 'error', message: 'connect ECONNREFUSED' }]);
    expect(report).toMatchObject({ status: 'partial', scanned: 120, failed: 1 });
    expect(finished).toMatchObject({ status: 'partial', error: '1 of 2 endpoint(s) failed' });
  });
});
