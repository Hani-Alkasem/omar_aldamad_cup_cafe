import { z } from 'zod';

export const WebhookKind = z.enum(['generic', 'slack', 'jira', 'servicenow']);
export type WebhookKind = z.infer<typeof WebhookKind>;

/** Events the platform emits. Subscriptions may also use "<entity>.*" or "*". */
export const EVENT_TYPES = [
  'asset.created',
  'asset.updated',
  'asset.deleted',
  'discovery.run.finished',
  'discovery.conflict',
  'contract.expiring',
  'maintenance.due',
  'ci_relationship.created',
  'ci_relationship.deleted',
  'application.created',
  'application.updated',
  'application.deleted',
  'credential.created',
  'credential.updated',
  'credential.deleted',
  'credential.accessed',
] as const;

const pattern = z
  .string()
  .trim()
  .regex(/^(\*|[a-z_]+\.(\*|[a-z_]+(\.[a-z_]+)*))$/, 'expected an event type such as asset.created, asset.* or *');

const httpsUrl = z.string().trim().url().max(2000);

/** Per-kind secret material. Never returned by the API once stored. */
export const WEBHOOK_SECRETS = {
  generic: z.object({ signingSecret: z.string().min(16).max(256).optional() }).strict(),
  slack: z.object({ webhookUrl: httpsUrl.refine((u) => u.startsWith('https://'), 'Slack webhook URLs are https') }).strict(),
  jira: z.object({ email: z.string().email().max(254), apiToken: z.string().min(8).max(512) }).strict(),
  servicenow: z.object({ username: z.string().min(1).max(200), password: z.string().min(1).max(512) }).strict(),
} as const;

export const WEBHOOK_CONFIG = {
  generic: z.object({}).strict(),
  slack: z.object({ channelLabel: z.string().max(80).optional() }).strict(),
  jira: z.object({ projectKey: z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/), issueType: z.string().min(1).max(60).default('Task') }).strict(),
  servicenow: z.object({ assignmentGroup: z.string().max(100).optional(), category: z.string().max(60).default('hardware') }).strict(),
} as const;

export const CreateWebhookSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    kind: WebhookKind,
    /** generic: the endpoint; jira/servicenow: the instance base URL; slack: omit (the URL is the secret). */
    url: httpsUrl.optional(),
    eventTypes: z.array(pattern).min(1).max(64),
    isEnabled: z.boolean().default(true),
    config: z.record(z.unknown()).default({}),
    secret: z.record(z.unknown()).default({}),
  })
  .superRefine((w, ctx) => {
    if (w.kind !== 'slack' && !w.url) ctx.addIssue({ code: 'custom', path: ['url'], message: `${w.kind} webhooks need a url` });
    for (const [key, schema, value] of [
      ['secret', WEBHOOK_SECRETS[w.kind], w.secret],
      ['config', WEBHOOK_CONFIG[w.kind], w.config],
    ] as const) {
      const r = (schema as z.ZodTypeAny).safeParse(value);
      if (!r.success) for (const i of r.error.issues) ctx.addIssue({ ...i, path: [key, ...i.path] });
    }
  });
export type CreateWebhookInput = z.infer<typeof CreateWebhookSchema>;

export const UpdateWebhookSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  url: httpsUrl.optional(),
  eventTypes: z.array(pattern).min(1).max(64).optional(),
  isEnabled: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
  /** Replaces the stored secret (rotation). */
  secret: z.record(z.unknown()).optional(),
});
export type UpdateWebhookInput = z.infer<typeof UpdateWebhookSchema>;

export const DeliveryStatus = z.enum(['pending', 'succeeded', 'failed', 'dead']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

/** What a generic webhook receives. Verify X-ITAM-Signature: t=<unix>,v1=hex(hmac_sha256(secret, `${t}.${body}`)). */
export interface WebhookEnvelope {
  id: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
}
