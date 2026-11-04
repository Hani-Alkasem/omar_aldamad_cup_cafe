import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { WEBHOOK_CONFIG, WEBHOOK_SECRETS, type CreateWebhookInput, type DeliveryStatus, type UpdateWebhookInput, type WebhookKind } from '@itam/shared';
import type { webhook_subscriptions } from '@prisma/client';
import ipaddr from 'ipaddr.js';
import { toDomainError } from '../../common/db-errors';
import { conflict, notFound, unprocessable } from '../../common/errors';
import { PrismaService, TX_OPTIONS, type Tx } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { Vault } from '../discovery/vault';
import { newSigningSecret } from './signing';
import { isAllowedAddress, parseAllowList } from './ssrf';

type Ctx = { user: AuthUser; requestId?: string };

const subDto = (s: webhook_subscriptions, health?: { succeeded: number; failed: number; dead: number; pending: number; last_error: string | null; last_delivered_at: Date | null }) => ({
  id: s.id,
  name: s.name,
  kind: s.kind,
  url: s.url,
  eventTypes: s.event_types,
  isEnabled: s.is_enabled,
  config: s.config,
  keyId: s.key_id,
  createdAt: s.created_at.toISOString(),
  updatedAt: s.updated_at.toISOString(),
  health: health
    ? { last24h: { succeeded: health.succeeded, failed: health.failed, dead: health.dead, pending: health.pending }, lastError: health.last_error, lastDeliveredAt: health.last_delivered_at?.toISOString() ?? null }
    : undefined,
});

@Injectable()
export class WebhooksService {
  private readonly allow = parseAllowList(process.env.WEBHOOK_ALLOW_PRIVATE_CIDRS);
  private readonly allowHttp = process.env.WEBHOOK_ALLOW_HTTP === 'true';

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly vault: Vault,
  ) {}

  /** Early, friendly rejection; the dispatcher re-checks every address at send time (DNS can change). */
  private checkUrl(raw: string) {
    const u = new URL(raw);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && this.allowHttp)) throw unprocessable('WEBHOOK_URL_FORBIDDEN', 'Webhook URLs must use https');
    if (u.username || u.password) throw unprocessable('WEBHOOK_URL_FORBIDDEN', 'Put credentials in the secret, not the URL');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (ipaddr.isValid(host) && !isAllowedAddress(host, this.allow)) {
      throw unprocessable('WEBHOOK_URL_FORBIDDEN', `${host} is not a public address; ask an operator to allow-list it (WEBHOOK_ALLOW_PRIVATE_CIDRS)`);
    }
  }

  private prepare(kind: WebhookKind, url: string | undefined, rawSecret: Record<string, unknown>, rawConfig: Record<string, unknown>) {
    const secret = WEBHOOK_SECRETS[kind].parse(rawSecret) as Record<string, string>;
    const config = WEBHOOK_CONFIG[kind].parse(rawConfig);
    let generated: string | undefined;
    if (kind === 'generic' && !secret.signingSecret) secret.signingSecret = generated = newSigningSecret();
    const target = kind === 'slack' ? secret.webhookUrl : url!;
    this.checkUrl(target);
    // A Slack URL is itself the credential: store only its origin in the clear.
    const displayUrl = kind === 'slack' ? new URL(target).origin : target;
    return { secret, config, displayUrl, generated };
  }

  async list() {
    const subs = await this.prisma.webhook_subscriptions.findMany({ orderBy: { name: 'asc' } });
    const health = await this.prisma.$queryRaw<Array<{ subscription_id: string; succeeded: number; failed: number; dead: number; pending: number; last_error: string | null; last_delivered_at: Date | null }>>`
      SELECT subscription_id,
             count(*) FILTER (WHERE status = 'succeeded')::int AS succeeded, count(*) FILTER (WHERE status = 'failed')::int AS failed,
             count(*) FILTER (WHERE status = 'dead')::int AS dead, count(*) FILTER (WHERE status = 'pending')::int AS pending,
             (array_agg(last_error ORDER BY id DESC) FILTER (WHERE last_error IS NOT NULL))[1] AS last_error,
             max(delivered_at) AS last_delivered_at
      FROM webhook_deliveries WHERE created_at > now() - interval '24 hours' GROUP BY subscription_id`;
    const empty = { succeeded: 0, failed: 0, dead: 0, pending: 0, last_error: null, last_delivered_at: null };
    return subs.map((s) => subDto(s, health.find((h) => h.subscription_id === s.id) ?? empty));
  }

  private async row(tx: Tx, id: string) {
    const s = await tx.webhook_subscriptions.findUnique({ where: { id } });
    if (!s) throw notFound('Webhook', id);
    return s;
  }

  async create(input: CreateWebhookInput, ctx: Ctx) {
    const { secret, config, displayUrl, generated } = this.prepare(input.kind, input.url, input.secret, input.config);
    const id = randomUUID();
    const sealed = this.vault.seal(secret, { id, kind: `webhook:${input.kind}` });
    return this.prisma.$transaction(async (tx) => {
      try {
        const s = await tx.webhook_subscriptions.create({
          data: {
            id, name: input.name, kind: input.kind, url: displayUrl, event_types: input.eventTypes, is_enabled: input.isEnabled, config,
            secret_ciphertext: sealed.ciphertext, secret_iv: sealed.iv, secret_tag: sealed.tag, key_id: sealed.keyId, created_by: ctx.user.id,
          },
        });
        const dto = subDto(s);
        await this.audit.record(tx, { entity: 'webhook', entityId: id, action: 'create', after: dto, userId: ctx.user.id, requestId: ctx.requestId });
        // Shown exactly once, so the receiver can verify signatures.
        return { ...dto, ...(generated ? { signingSecret: generated } : {}) };
      } catch (err) {
        if (toDomainError(err)?.code === 'DUPLICATE') throw conflict('WEBHOOK_EXISTS', `A webhook named "${input.name}" already exists`);
        throw err;
      }
    }, TX_OPTIONS);
  }

  async update(id: string, input: UpdateWebhookInput, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      const cur = await this.row(tx, id);
      const data: Record<string, unknown> = {};
      if (input.name !== undefined) data.name = input.name;
      if (input.eventTypes !== undefined) data.event_types = input.eventTypes;
      if (input.isEnabled !== undefined) data.is_enabled = input.isEnabled;
      if (input.config !== undefined) data.config = WEBHOOK_CONFIG[cur.kind].parse(input.config);
      if (input.url !== undefined) {
        if (cur.kind === 'slack') throw unprocessable('WEBHOOK_URL_IN_SECRET', 'A Slack webhook URL is a secret; rotate it with { secret: { webhookUrl } }');
        this.checkUrl(input.url);
        data.url = input.url;
      }
      if (input.secret !== undefined) {
        const p = this.prepare(cur.kind, (data.url as string) ?? cur.url, input.secret, (data.config as Record<string, unknown>) ?? (cur.config as Record<string, unknown>));
        if (p.generated) throw unprocessable('SECRET_REQUIRED', 'Provide the new signingSecret when rotating');
        const sealed = this.vault.seal(p.secret, { id, kind: `webhook:${cur.kind}` });
        Object.assign(data, { secret_ciphertext: sealed.ciphertext, secret_iv: sealed.iv, secret_tag: sealed.tag, key_id: sealed.keyId });
        if (cur.kind === 'slack') data.url = p.displayUrl;
      }
      const after = await tx.webhook_subscriptions.update({ where: { id }, data });
      await this.audit.record(tx, { entity: 'webhook', entityId: id, action: 'update', before: { ...subDto(cur), secretVersion: cur.updated_at }, after: { ...subDto(after), secretVersion: input.secret ? after.updated_at : cur.updated_at }, userId: ctx.user.id, requestId: ctx.requestId });
      return subDto(after);
    }, TX_OPTIONS);
  }

  async remove(id: string, ctx: Ctx) {
    await this.prisma.$transaction(async (tx) => {
      const cur = await this.row(tx, id);
      await tx.webhook_subscriptions.delete({ where: { id } });
      await this.audit.record(tx, { entity: 'webhook', entityId: id, action: 'delete', before: subDto(cur), userId: ctx.user.id, requestId: ctx.requestId });
    }, TX_OPTIONS);
  }

  /** Queue a ping to this subscription only; the dispatcher sends it within a second or two. */
  async test(id: string, ctx: Ctx) {
    return this.prisma.$transaction(async (tx) => {
      await this.row(tx, id);
      const [ev] = await tx.$queryRaw<Array<{ id: bigint }>>`
        INSERT INTO outbox_events (type, entity, entity_id, payload, request_id)
        VALUES ('webhook.ping', 'webhook', ${id}, ${JSON.stringify({ message: 'Test event from ITAM', requestedBy: ctx.user.email })}::jsonb, ${ctx.requestId ?? null})
        RETURNING id`;
      const [d] = await tx.$queryRaw<Array<{ id: bigint }>>`INSERT INTO webhook_deliveries (subscription_id, event_id) VALUES (${id}::uuid, ${ev.id}) RETURNING id`;
      return { deliveryId: d.id.toString(), eventId: ev.id.toString() };
    }, TX_OPTIONS);
  }

  async deliveries(id: string, status?: DeliveryStatus, limit = 50) {
    const rows = await this.prisma.$queryRaw<Array<{ id: bigint; status: string; attempts: number; next_attempt_at: Date; last_status_code: number | null; last_error: string | null; response_ms: number | null; created_at: Date; delivered_at: Date | null; type: string; event_id: bigint }>>`
      SELECT d.id, d.status, d.attempts, d.next_attempt_at, d.last_status_code, d.last_error, d.response_ms, d.created_at, d.delivered_at, e.type, e.id AS event_id
      FROM webhook_deliveries d JOIN outbox_events e ON e.id = d.event_id
      WHERE d.subscription_id = ${id}::uuid AND (${status ?? null}::delivery_status IS NULL OR d.status = ${status ?? null}::delivery_status)
      ORDER BY d.id DESC LIMIT ${Math.min(Math.max(limit, 1), 200)}`;
    if (!rows.length) await this.row(this.prisma, id);
    return rows.map((r) => ({
      id: r.id.toString(),
      eventId: r.event_id.toString(),
      eventType: r.type,
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: r.status === 'pending' || r.status === 'failed' ? r.next_attempt_at.toISOString() : null,
      lastStatusCode: r.last_status_code,
      lastError: r.last_error,
      responseMs: r.response_ms,
      createdAt: r.created_at.toISOString(),
      deliveredAt: r.delivered_at?.toISOString() ?? null,
    }));
  }

  /** Send again now with a fresh retry budget (after fixing the receiver). */
  async replay(deliveryId: string, ctx: Ctx) {
    if (!/^\d{1,18}$/.test(deliveryId)) throw notFound('Delivery', deliveryId);
    return this.prisma.$transaction(async (tx) => {
      const [d] = await tx.$queryRaw<Array<{ id: bigint; status: string; subscription_id: string }>>`
        SELECT id, status, subscription_id FROM webhook_deliveries WHERE id = ${BigInt(deliveryId)} FOR UPDATE`;
      if (!d) throw notFound('Delivery', deliveryId);
      if (d.status === 'pending') throw conflict('DELIVERY_PENDING', 'That delivery is already queued');
      await tx.$executeRaw`
        UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now(), delivered_at = NULL, last_error = NULL
        WHERE id = ${d.id}`;
      await this.audit.record(tx, { entity: 'webhook', entityId: d.subscription_id, action: 'update', before: { deliveryId, status: d.status }, after: { deliveryId, status: 'pending', replayed: true }, userId: ctx.user.id, requestId: ctx.requestId });
      return { id: deliveryId, status: 'pending' };
    }, TX_OPTIONS);
  }
}
