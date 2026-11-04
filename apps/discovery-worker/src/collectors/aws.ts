import { DescribeInstanceTypesCommand, EC2Client, paginateDescribeInstances, type Instance, type InstanceTypeInfo } from '@aws-sdk/client-ec2';
import type { DiscoveryOptions, HostFacts } from '@itam/shared';
import { boundedTags, primaryIp, type InventoryCollector, type InventoryResult } from './inventory';
import type { Credential } from './types';

const AUTH_ERRORS = new Set(['AuthFailure', 'UnauthorizedOperation', 'InvalidClientTokenId', 'SignatureDoesNotMatch', 'ExpiredToken', 'UnrecognizedClientException']);

/**
 * EC2 inventory for one region: every instance that is not terminated, with type sizing.
 * Needs only ec2:DescribeInstances and ec2:DescribeInstanceTypes.
 */
export class AwsCollector implements InventoryCollector {
  constructor(private readonly makeClient = (region: string, c: Extract<Credential, { kind: 'aws' }>, opts: DiscoveryOptions) =>
    new EC2Client({
      region,
      credentials: { accessKeyId: c.secret.accessKeyId, secretAccessKey: c.secret.secretAccessKey, sessionToken: c.secret.sessionToken },
      ...(opts.apiBaseUrl ? { endpoint: opts.apiBaseUrl } : {}),
      maxAttempts: 3,
    })) {}

  async inventory(region: string, cred: Credential, opts: DiscoveryOptions): Promise<InventoryResult> {
    if (cred.kind !== 'aws') return { kind: 'error', message: `${cred.kind} is not an AWS credential` };
    const client = this.makeClient(region, cred, opts);
    try {
      const instances: Array<{ i: Instance; owner: string }> = [];
      for await (const page of paginateDescribeInstances({ client, pageSize: 500 }, { MaxResults: 500 })) {
        for (const r of page.Reservations ?? []) for (const i of r.Instances ?? []) if (i.State?.Name !== 'terminated') instances.push({ i, owner: r.OwnerId ?? 'unknown' });
      }
      const types = [...new Set(instances.map((x) => x.i.InstanceType).filter((t): t is NonNullable<typeof t> => Boolean(t)))];
      const sizing = new Map<string, InstanceTypeInfo>();
      for (let k = 0; k < types.length; k += 100) {
        const res = await client.send(new DescribeInstanceTypesCommand({ InstanceTypes: types.slice(k, k + 100) }));
        for (const t of res.InstanceTypes ?? []) if (t.InstanceType) sizing.set(t.InstanceType, t);
      }
      const hosts: HostFacts[] = instances.map(({ i, owner }) => {
        const t = i.InstanceType ? sizing.get(i.InstanceType) : undefined;
        const name = i.Tags?.find((x) => x.Key === 'Name')?.Value;
        const vcpus = i.CpuOptions?.CoreCount && i.CpuOptions.ThreadsPerCore ? i.CpuOptions.CoreCount * i.CpuOptions.ThreadsPerCore : t?.VCpuInfo?.DefaultVCpus;
        return {
          externalId: `aws:${owner}:${region}:${i.InstanceId}`,
          protocol: 'aws',
          hostname: name || i.PrivateDnsName || i.InstanceId,
          ip: primaryIp([i.PrivateIpAddress, i.Ipv6Address]),
          vendor: 'Amazon EC2',
          model: i.InstanceType,
          os: i.PlatformDetails,
          isVirtual: true,
          cpuCores: vcpus,
          memoryGb: t?.MemoryInfo?.SizeInMiB ? t.MemoryInfo.SizeInMiB / 1024 : undefined,
          disks: [],
          interfaces: (i.NetworkInterfaces ?? []).map((n) => ({ name: (n.NetworkInterfaceId ?? `eth${n.Attachment?.DeviceIndex ?? 0}`).slice(0, 64), ...(n.MacAddress ? { mac: n.MacAddress.toLowerCase() } : {}) })),
          cloud: { provider: 'aws', kind: 'vm', region, account: owner, instanceType: i.InstanceType, state: i.State?.Name },
          tags: boundedTags((i.Tags ?? []).map((x) => ({ key: x.Key, value: x.Value }))),
        };
      });
      return { kind: 'facts', hosts, warnings: [] };
    } catch (e) {
      const err = e as Error & { name?: string; Code?: string };
      if (AUTH_ERRORS.has(err.name ?? '') || AUTH_ERRORS.has(err.Code ?? '')) return { kind: 'auth_failed', message: `AWS rejected the credential (${err.name})` };
      return { kind: 'error', message: `${err.name ?? 'Error'}: ${err.message}`.slice(0, 300) };
    } finally {
      client.destroy();
    }
  }
}
