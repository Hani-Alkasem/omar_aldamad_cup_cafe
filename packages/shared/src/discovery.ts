import { z } from 'zod';

const uuid = z.string().uuid();

export const DiscoveryProtocol = z.enum(['snmp', 'ssh', 'vsphere', 'aws', 'azure']);
export type DiscoveryProtocol = z.infer<typeof DiscoveryProtocol>;
/** Protocols that read an inventory API per endpoint instead of sweeping addresses. */
export const INVENTORY_PROTOCOLS = ['vsphere', 'aws', 'azure'] as const;
export const isInventoryProtocol = (p: DiscoveryProtocol): p is (typeof INVENTORY_PROTOCOLS)[number] => (INVENTORY_PROTOCOLS as readonly string[]).includes(p);

export const CredentialKind = z.enum(['snmp_v2c', 'snmp_v3', 'ssh_password', 'ssh_key', 'vsphere', 'aws', 'azure']);
export type CredentialKind = z.infer<typeof CredentialKind>;

export const PROTOCOL_KINDS: Record<DiscoveryProtocol, readonly CredentialKind[]> = {
  snmp: ['snmp_v2c', 'snmp_v3'],
  ssh: ['ssh_password', 'ssh_key'],
  vsphere: ['vsphere'],
  aws: ['aws'],
  azure: ['azure'],
};
const USERNAME_OPTIONAL: readonly CredentialKind[] = ['snmp_v2c', 'aws', 'azure'];

/* ---------- Vault: secret payloads per kind (never returned by the public API) ---------- */

export const SnmpV2cSecret = z.object({ community: z.string().min(1).max(255) }).strict();
export const SnmpV3Secret = z
  .object({
    authProtocol: z.enum(['sha', 'sha256', 'sha512', 'md5']).default('sha256'),
    authKey: z.string().min(8).max(255),
    privProtocol: z.enum(['aes', 'aes256', 'des']).default('aes'),
    privKey: z.string().min(8).max(255),
  })
  .strict();
export const SshPasswordSecret = z.object({ password: z.string().min(1).max(1024) }).strict();
export const SshKeySecret = z
  .object({
    privateKey: z
      .string()
      .max(16_384)
      .regex(/^-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+-----END [A-Z ]*PRIVATE KEY-----\s*$/, 'expected a PEM/OpenSSH private key'),
    passphrase: z.string().max(1024).optional(),
  })
  .strict();

/** vCenter: a read-only role is enough (System.View on the inventory root). Username is the account. */
export const VsphereSecret = z.object({ password: z.string().min(1).max(1024) }).strict();
/** IAM user keys for ec2:Describe* (ReadOnlyAccess or AmazonEC2ReadOnlyAccess). */
export const AwsSecret = z
  .object({
    accessKeyId: z.string().regex(/^(AKIA|ASIA)[A-Z0-9]{12,}$/, 'expected an AWS access key id'),
    secretAccessKey: z.string().min(20).max(128),
    sessionToken: z.string().max(4096).optional(),
  })
  .strict();
/** Entra ID app registration with the Reader role on the subscriptions. */
export const AzureSecret = z
  .object({
    tenantId: z.string().uuid(),
    clientId: z.string().uuid(),
    clientSecret: z.string().min(8).max(512),
  })
  .strict();

export const SECRET_SCHEMAS = {
  snmp_v2c: SnmpV2cSecret,
  snmp_v3: SnmpV3Secret,
  ssh_password: SshPasswordSecret,
  ssh_key: SshKeySecret,
  vsphere: VsphereSecret,
  aws: AwsSecret,
  azure: AzureSecret,
} as const;

export type CredentialSecret =
  | { kind: 'snmp_v2c'; secret: z.infer<typeof SnmpV2cSecret> }
  | { kind: 'snmp_v3'; secret: z.infer<typeof SnmpV3Secret> }
  | { kind: 'ssh_password'; secret: z.infer<typeof SshPasswordSecret> }
  | { kind: 'ssh_key'; secret: z.infer<typeof SshKeySecret> }
  | { kind: 'vsphere'; secret: z.infer<typeof VsphereSecret> }
  | { kind: 'aws'; secret: z.infer<typeof AwsSecret> }
  | { kind: 'azure'; secret: z.infer<typeof AzureSecret> };

export const CreateCredentialSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: CredentialKind,
    username: z.string().trim().min(1).max(128).optional(),
    secret: z.record(z.unknown()),
  })
  .superRefine((c, ctx) => {
    if (!USERNAME_OPTIONAL.includes(c.kind) && !c.username) ctx.addIssue({ code: 'custom', path: ['username'], message: `${c.kind} needs a username` });
    const r = SECRET_SCHEMAS[c.kind].safeParse(c.secret);
    if (!r.success) for (const i of r.error.issues) ctx.addIssue({ ...i, path: ['secret', ...i.path] });
  });
export type CreateCredentialInput = z.infer<typeof CreateCredentialSchema>;

export const RotateSecretSchema = z.object({ secret: z.record(z.unknown()) });
export type RotateSecretInput = z.infer<typeof RotateSecretSchema>;

/* ---------- Jobs ---------- */

export const DiscoveryOptions = z
  .object({
    /** Per-host timeout for one credential attempt. */
    timeoutMs: z.number().int().min(250).max(60_000).default(3000),
    /** Hosts probed in parallel by one worker. */
    concurrency: z.number().int().min(1).max(256).default(32),
    port: z.number().int().min(1).max(65535).optional(),
    /** vCenter with a private CA: its PEM. Preferred over tlsInsecure. */
    tlsCaPem: z.string().max(65_536).regex(/-----BEGIN CERTIFICATE-----/).optional(),
    /** Skip certificate checks (lab vCenters only); the job shows a warning. */
    tlsInsecure: z.boolean().default(false),
    /** Override the API base (Azure Government/China, AWS endpoints in an air-gapped region, tests). */
    apiBaseUrl: z.string().url().max(500).optional(),
    authBaseUrl: z.string().url().max(500).optional(),
  })
  .strict();
export type DiscoveryOptions = z.infer<typeof DiscoveryOptions>;

const cron = z
  .string()
  .trim()
  .regex(/^(\S+\s+){4}\S+(\s+\S+)?$/, 'expected a 5- or 6-field cron expression');

/** An endpoint per inventory protocol: a vCenter URL, an AWS region, an Azure subscription id. */
export const ENDPOINT_PATTERNS: Record<(typeof INVENTORY_PROTOCOLS)[number], { re: RegExp; hint: string }> = {
  vsphere: { re: /^https:\/\/[a-z0-9.-]+(:\d{1,5})?\/?$/i, hint: 'https://vcenter.example.com' },
  aws: { re: /^[a-z]{2}(-gov|-iso[a-z]?)?-[a-z]+-\d$/, hint: 'an AWS region such as eu-west-1' },
  azure: { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, hint: 'an Azure subscription id' },
};

const jobFields = {
  name: z.string().trim().min(1).max(100),
  protocol: DiscoveryProtocol,
  /** snmp/ssh: CIDRs or addresses to sweep. */
  targets: z.array(z.string().trim().min(1).max(64)).max(64).default([]),
  /** vsphere/aws/azure: where to read the inventory. */
  endpoints: z.array(z.string().trim().min(1).max(300)).max(64).default([]),
  credentialIds: z.array(uuid).min(1).max(16),
  scheduleCron: cron.nullable().optional(),
  vrfId: uuid.nullable().optional(),
  maxHosts: z.number().int().min(1).max(65_536).default(1024),
  isEnabled: z.boolean().default(true),
  options: DiscoveryOptions.default({}),
};

export function checkJobScope(j: { protocol?: DiscoveryProtocol; targets?: string[]; endpoints?: string[] }, ctx: z.RefinementCtx) {
  if (!j.protocol) return;
  if (isInventoryProtocol(j.protocol)) {
    if (j.targets?.length) ctx.addIssue({ code: 'custom', path: ['targets'], message: `${j.protocol} jobs read endpoints, not targets` });
    if (j.endpoints && !j.endpoints.length) ctx.addIssue({ code: 'custom', path: ['endpoints'], message: `give at least one endpoint (${ENDPOINT_PATTERNS[j.protocol].hint})` });
    for (const [i, e] of (j.endpoints ?? []).entries()) {
      if (!ENDPOINT_PATTERNS[j.protocol].re.test(e)) ctx.addIssue({ code: 'custom', path: ['endpoints', i], message: `expected ${ENDPOINT_PATTERNS[j.protocol].hint}` });
    }
  } else {
    if (j.endpoints?.length) ctx.addIssue({ code: 'custom', path: ['endpoints'], message: `${j.protocol} jobs sweep targets, not endpoints` });
    if (j.targets && !j.targets.length) ctx.addIssue({ code: 'custom', path: ['targets'], message: 'give at least one CIDR or address' });
  }
}

export const CreateJobSchema = z.object(jobFields).superRefine(checkJobScope);
export type CreateJobInput = z.infer<typeof CreateJobSchema>;

export const UpdateJobSchema = z
  .object(jobFields)
  .partial()
  .extend({ targets: jobFields.targets.removeDefault().optional(), endpoints: jobFields.endpoints.removeDefault().optional() });
export type UpdateJobInput = z.infer<typeof UpdateJobSchema>;

/* ---------- Worker → API: collected host facts ---------- */

const mac = z
  .string()
  .regex(/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i)
  .transform((m) => m.toLowerCase().replace(/-/g, ':'));
const short = (n: number) => z.string().trim().max(n);

const ExternalId = z.string().regex(/^(vsphere|aws|azure):[A-Za-z0-9:/._@-]{1,400}$/, 'expected a provider id such as vsphere:<vcenter>:vm-42');

export const HostFactsSchema = z.object({
  /** Address that answered (sweeps), or the primary guest/private IP (inventory). */
  ip: z.string().min(2).max(45).optional(),
  /** Provider id from an inventory API; the strongest identity key. */
  externalId: ExternalId.optional(),
  /** Inventory: the hypervisor host this VM runs on (its externalId). */
  runsOn: ExternalId.optional(),
  /** Inventory: where it lives in the provider. */
  cloud: z
    .object({
      provider: z.enum(['vsphere', 'aws', 'azure']),
      region: short(100).optional(),
      account: short(200).optional(),
      instanceType: short(100).optional(),
      state: short(50).optional(),
      kind: z.enum(['host', 'vm']).optional(),
    })
    .optional(),
  tags: z.record(short(128), short(256)).optional(),
  protocol: DiscoveryProtocol,
  hostname: short(255).optional(),
  vendor: short(200).optional(),
  model: short(200).optional(),
  serialNumber: short(128).optional(),
  systemUuid: uuid.optional(),
  os: short(255).optional(),
  sysDescr: short(1024).optional(),
  sysObjectId: z.string().regex(/^[0-9.]+$/).max(256).optional(),
  isVirtual: z.boolean().optional(),
  cpuCores: z.number().int().min(0).max(100_000).optional(),
  memoryGb: z.number().min(0).max(1e7).optional(),
  disks: z.array(z.object({ name: short(64), sizeGb: z.number().min(0).max(1e9), model: short(200).optional() })).max(256).default([]),
  interfaces: z.array(z.object({ name: short(64).min(1), mac: mac.optional(), speedMbps: z.number().int().positive().max(1_600_000).optional() })).max(1024).default([]),
  /** Listening TCP sockets (server side of a dependency). */
  listeners: z.array(z.object({ port: z.number().int().min(1).max(65535), process: short(64).optional() })).max(512).default([]),
  /** Established TCP sessions; the reconciler keeps the client-side ones as dependencies. */
  connections: z
    .array(z.object({ remoteIp: z.string().min(2).max(45), remotePort: z.number().int().min(1).max(65535), localPort: z.number().int().min(1).max(65535), process: short(64).optional() }))
    .max(4096)
    .default([]),
  /** SHA-256 of the SSH host key, base64; a change against the stored value is flagged. */
  sshHostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/=]{43,44}$/).optional(),
}).refine((f) => f.ip || f.externalId, { message: 'a host needs an ip or an externalId', path: ['ip'] });
export type HostFacts = z.input<typeof HostFactsSchema>;
export type ParsedHostFacts = z.output<typeof HostFactsSchema>;

export const HostFailureSchema = z.object({
  /** The address, or for inventory jobs the endpoint that failed. */
  ip: z.string().min(2).max(300),
  outcome: z.enum(['auth_failed', 'error']),
  message: short(500),
});
export type HostFailure = z.infer<typeof HostFailureSchema>;

export const SubmitHostsSchema = z.object({
  /** Hosts probed since the last call, responding or not; drives progress. */
  scannedDelta: z.number().int().min(0).max(65_536),
  hosts: z.array(HostFactsSchema).max(200).default([]),
  failures: z.array(HostFailureSchema).max(200).default([]),
});
export type SubmitHostsInput = z.input<typeof SubmitHostsSchema>;

export const FinishRunSchema = z.object({
  status: z.enum(['succeeded', 'failed', 'partial']),
  error: short(2000).optional(),
});
export type FinishRunInput = z.infer<typeof FinishRunSchema>;

/** What a worker receives when it claims a run. Secrets travel over HTTPS only, never through Redis. */
export interface RunSpec {
  runId: string;
  jobId: string;
  protocol: DiscoveryProtocol;
  targets: string[];
  endpoints: string[];
  maxHosts: number;
  options: DiscoveryOptions;
  leaseSeconds: number;
  credentials: Array<CredentialSecret & { id: string; name: string; username: string | null }>;
}

/** BullMQ payload: ids only. */
export interface DiscoveryQueueJob {
  jobId: string;
  runId?: string;
}
export const DISCOVERY_QUEUE = 'discovery';
