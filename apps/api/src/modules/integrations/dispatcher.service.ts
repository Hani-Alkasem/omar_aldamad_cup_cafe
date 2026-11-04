import { Injectable, Logger } from '@nestjs/common';
import type { WebhookEnvelope, WebhookKind } from '@itam/shared';
import { PrismaService } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Vault, VaultError } from '../discovery/vault';
import { webhookDeliveries, webhookLatency } from '../../common/observability/metrics';
import { buildRequest } from './adapters';
import { isRetryableStatus, MAX_ATTEMPTS, retryDelayMs } from './backoff';
import { ForbiddenAddressError, parseAllowList, safeRequest } from './ssrf';

interface Claimed {
  id: bigint;
  attempts: number;
  subscription_id: string;
  kind: WebhookKind;
  url: string;
  config: Record<string, unknown>;
  is_enabled: boolean;
  secret_ciphertext: Buffer;
  secret_iv: Buffer;
  secret_tag: Buffer;
  key_id: string;
  event_id: bigint;
  type: string;
  occurred_at: Date;
  payload: Record<string, unknown>;
}

type Outcome = { status: 'succeeded' | 'failed' | 'dead'; code: number | null; error: string | null; ms: number | null; retryInMs?: number };

/** A claim hides a row from other dispatchers this long; a crash mid-send simply retries after it. */
const CLAIM_SECONDS = 120;
const PARALLEL = 8;

/**
 * Delivers outbox events. Any number of replicas can run: rows are claimed with
 * FOR UPDATE SKIP LOCKED and a short lease, then sent outside any transaction.
 * Delivery is at-least-once; receivers dedupe on X-ITAM-Delivery (or the event id).
 */
@Injectable()
export class DispatcherService {
  private readonly log = new Logger('Dispatcher');
  private readonly allow = parseAllowList(process.env.WEBHOOK_ALLOW_PRIVATE_CIDRS);
  private readonly allowHttp = process.env.WEBHOOK_ALLOW_HTTP === 'true';
  private readonly baseUrl = process.env.PUBLIC_BASE_URL;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: Vault,
    private readonly audit: AuditService,
  ) {}

  /** Claim and send one batch. Returns how many deliveries were attempted. */
  async tick(limit = 25): Promise<number> {
    const rows = await this.prisma.$queryRaw<Claimed[]>`
      WITH claimed AS (
        UPDATE webhook_deliveries d SET attempts = d.attempts + 1, next_attempt_at = now() + make_interval(secs => ${CLAIM_SECONDS})
        WHERE d.id IN (
          SELECT id FROM webhook_deliveries WHERE status IN ('pending', 'failed') AND next_attempt_at <= now()
          ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED
        )
        RETURNING d.id, d.attempts, d.subscription_id, d.event_id
      )
      SELECT c.id, c.attempts, c.subscription_id, s.kind, s.url, s.config, s.is_enabled, s.secret_ciphertext, s.secret_iv, s.secret_tag, s.key_id,
             c.event_id, e.type, e.occurred_at, e.payload
      FROM claimed c JOIN webhook_subscriptions s ON s.id = c.subscription_id JOIN outbox_events e ON e.id = c.event_id`;
    for (let i = 0; i < rows.length; i += PARALLEL) await Promise.all(rows.slice(i, i + PARALLEL).map((r) => this.deliver(r)));
    return rows.length;
  }

  private async send(r: Claimed): Promise<Outcome> {
    if (!r.is_enabled) return { status: 'dead', code: null, error: 'subscription is disabled', ms: null };
    let secret: Record<string, string>;
    try {
      secret = this.vault.open({ ciphertext: Buffer.from(r.secret_ciphertext), iv: Buffer.from(r.secret_iv), tag: Buffer.from(r.secret_tag), keyId: r.key_id }, { id: r.subscription_id, kind: `webhook:${r.kind}` });
    } catch (e) {
      if (e instanceof VaultError) return { status: 'dead', code: null, error: e.message, ms: null };
      throw e;
    }
    const envelope: WebhookEnvelope = { id: r.event_id.toString(), type: r.type, occurredAt: r.occurred_at.toISOString(), data: r.payload };
    const req = buildRequest(r.kind, { url: r.url, secret, config: r.config }, envelope, r.id.toString(), { baseUrl: this.baseUrl });
    try {
      const res = await safeRequest({ url: req.url, headers: req.headers, body: req.body, allow: this.allow, allowHttp: this.allowHttp });
      if (res.status >= 200 && res.status < 300) return { status: 'succeeded', code: res.status, error: null, ms: res.ms };
      const error = `HTTP ${res.status}${res.body ? `: ${res.body.slice(0, 300)}` : ''}`;
      if (!isRetryableStatus(res.status)) return { status: 'dead', code: res.status, error, ms: res.ms };
      return { status: 'failed', code: res.status, error, ms: res.ms, retryInMs: retryDelayMs(r.attempts, res.headers['retry-after']) };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 300);
      if (e instanceof ForbiddenAddressError) return { status: 'dead', code: null, error: `blocked: ${msg}`, ms: null };
      return { status: 'failed', code: null, error: msg, ms: null, retryInMs: retryDelayMs(r.attempts) };
    }
  }

  private async deliver(r: Claimed) {
    let o = await this.send(r).catch((e: Error) => ({ status: 'failed' as const, code: null, error: e.message.slice(0, 300), ms: null, retryInMs: retryDelayMs(r.attempts) }));
    if (o.status === 'failed' && r.attempts >= MAX_ATTEMPTS) o = { ...o, status: 'dead', error: `gave up after ${r.attempts} attempts: ${o.error}` };
    await this.prisma.$executeRaw`
      UPDATE webhook_deliveries SET
        status = ${o.status}::delivery_status,
        last_status_code = ${o.code},
        last_error = ${o.error},
        response_ms = ${o.ms},
        delivered_at = CASE WHEN ${o.status} = 'succeeded' THEN now() ELSE NULL END,
        next_attempt_at = now() + make_interval(secs => ${Math.ceil((o.retryInMs ?? 0) / 1000)})
      WHERE id = ${r.id}`;
    webhookDeliveries.inc({ kind: r.kind, status: o.status });
    if (o.ms != null) webhookLatency.observe({ kind: r.kind }, o.ms / 1000);
    if (o.status !== 'succeeded') this.log.warn(`delivery ${r.id} (${r.type} → ${r.kind}) ${o.status}: ${o.error}`);
  }

  /**
   * Time-based events. Idempotent per day via dedupe keys, so every replica may run it.
   * contract.expiring: in its notice window (end − notice days ≤ today ≤ end). maintenance.due: due today or overdue.
   */
  async emitScheduled(today = new Date().toISOString().slice(0, 10)) {
    const contracts = await this.prisma.$queryRaw<Array<{ id: string; contract_type: string; contract_number: string; end_date: Date; auto_renew: boolean; vendor: string; asset_count: number; days_left: number }>>`
      SELECT c.id, c.contract_type, c.contract_number, c.end_date, c.auto_renew, v.name AS vendor,
             (SELECT count(*)::int FROM contract_assets ca WHERE ca.contract_id = c.id) AS asset_count,
             (c.end_date - ${today}::date)::int AS days_left
      FROM contracts c JOIN vendors v ON v.id = c.vendor_id
      WHERE ${today}::date BETWEEN c.end_date - c.notice_days AND c.end_date`;
    for (const c of contracts) {
      await this.audit.emit(this.prisma, {
        type: 'contract.expiring', entity: 'contract', entityId: c.id, dedupeKey: `contract.expiring:${c.id}:${today}`,
        payload: { contractId: c.id, contractType: c.contract_type, contractNumber: c.contract_number, vendor: c.vendor, endDate: c.end_date.toISOString().slice(0, 10), daysLeft: c.days_left, autoRenew: c.auto_renew, assetCount: c.asset_count },
      });
    }
    const due = await this.prisma.$queryRaw<Array<{ id: string; title: string; next_due_on: Date; asset_id: string; asset_name: string }>>`
      SELECT m.id, m.title, m.next_due_on, a.id AS asset_id, a.name AS asset_name
      FROM maintenance_schedules m JOIN assets a ON a.id = m.asset_id WHERE m.next_due_on <= ${today}::date`;
    for (const m of due) {
      await this.audit.emit(this.prisma, {
        type: 'maintenance.due', entity: 'maintenance', entityId: m.id, dedupeKey: `maintenance.due:${m.id}:${today}`,
        payload: { scheduleId: m.id, title: m.title, nextDueOn: m.next_due_on.toISOString().slice(0, 10), assetId: m.asset_id, assetName: m.asset_name },
      });
    }
    return { contracts: contracts.length, maintenance: due.length };
  }

  /** Retention: old events (and their finished deliveries) go; anything still being retried stays. */
  async prune(days = Number(process.env.OUTBOX_RETENTION_DAYS ?? 30)) {
    return this.prisma.$executeRaw`
      DELETE FROM outbox_events e WHERE e.occurred_at < now() - make_interval(days => ${days})
        AND NOT EXISTS (SELECT 1 FROM webhook_deliveries d WHERE d.event_id = e.id AND d.status IN ('pending', 'failed'))`;
  }

  async run(onBeat: () => void = () => undefined) {
    let lastHousekeeping = 0;
    this.log.log('dispatcher started');
    while (!this.stopped) {
      try {
        if (Date.now() - lastHousekeeping > 3600_000) {
          lastHousekeeping = Date.now();
          const s = await this.emitScheduled();
          const pruned = await this.prune();
          this.log.log(`housekeeping: ${s.contracts} expiring contract(s), ${s.maintenance} due maintenance, ${pruned} old event(s) pruned`);
        }
        const n = await this.tick();
        onBeat();
        if (n === 0) await new Promise((r) => setTimeout(r, 1000));
      } catch (e) {
        this.log.error(`tick failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  stop() {
    this.stopped = true;
  }
}
