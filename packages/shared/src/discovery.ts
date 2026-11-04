import { z } from 'zod';

const uuid = z.string().uuid();

export const DiscoveryProtocol = z.enum(['snmp', 'ssh']);
export type DiscoveryProtocol = z.infer<typeof DiscoveryProtocol>;

export const CredentialKind = z.enum(['snmp_v2c', 'snmp_v3', 'ssh_password', 'ssh_key']);
export type CredentialKind = z.infer<typeof CredentialKind>;

export const PROTOCOL_KINDS: Record<DiscoveryProtocol, readonly CredentialKind[]> = {
  snmp: ['snmp_v2c', 'snmp_v3'],
  ssh: ['ssh_password', 'ssh_key'],
};

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

export const SECRET_SCHEMAS = {
  snmp_v2c: SnmpV2cSecret,
  snmp_v3: SnmpV3Secret,
  ssh_password: SshPasswordSecret,
  ssh_key: SshKeySecret,
} as const;

export type CredentialSecret =
  | { kind: 'snmp_v2c'; secret: z.infer<typeof SnmpV2cSecret> }
  | { kind: 'snmp_v3'; secret: z.infer<typeof SnmpV3Secret> }
  | { kind: 'ssh_password'; secret: z.infer<typeof SshPasswordSecret> }
  | { kind: 'ssh_key'; secret: z.infer<typeof SshKeySecret> };

export const CreateCredentialSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: CredentialKind,
    username: z.string().trim().min(1).max(128).optional(),
    secret: z.record(z.unknown()),
  })
  .superRefine((c, ctx) => {
    if (c.kind !== 'snmp_v2c' && !c.username) ctx.addIssue({ code: 'custom', path: ['username'], message: `${c.kind} needs a username` });
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
  })
  .strict();
export type DiscoveryOptions = z.infer<typeof DiscoveryOptions>;

const cron = z
  .string()
  .trim()
  .regex(/^(\S+\s+){4}\S+(\s+\S+)?$/, 'expected a 5- or 6-field cron expression');

export const CreateJobSchema = z.object({
  name: z.string().trim().min(1).max(100),
  protocol: DiscoveryProtocol,
  targets: z.array(z.string().trim().min(1).max(64)).min(1).max(64),
  credentialIds: z.array(uuid).min(1).max(16),
  scheduleCron: cron.nullable().optional(),
  vrfId: uuid.nullable().optional(),
  maxHosts: z.number().int().min(1).max(65_536).default(1024),
  isEnabled: z.boolean().default(true),
  options: DiscoveryOptions.default({}),
});
export type CreateJobInput = z.infer<typeof CreateJobSchema>;

export const UpdateJobSchema = CreateJobSchema.partial();
export type UpdateJobInput = z.infer<typeof UpdateJobSchema>;

/* ---------- Worker → API: collected host facts ---------- */

const mac = z
  .string()
  .regex(/^([0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i)
  .transform((m) => m.toLowerCase().replace(/-/g, ':'));
const short = (n: number) => z.string().trim().max(n);

export const HostFactsSchema = z.object({
  ip: z.string().min(2).max(45),
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
  /** SHA-256 of the SSH host key, base64; a change against the stored value is flagged. */
  sshHostKey: z.string().regex(/^SHA256:[A-Za-z0-9+/=]{43,44}$/).optional(),
});
export type HostFacts = z.input<typeof HostFactsSchema>;
export type ParsedHostFacts = z.output<typeof HostFactsSchema>;

export const HostFailureSchema = z.object({
  ip: z.string().min(2).max(45),
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
