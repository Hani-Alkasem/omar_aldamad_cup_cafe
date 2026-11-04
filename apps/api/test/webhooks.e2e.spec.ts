import 'reflect-metadata';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { PrismaModule } from '../src/common/prisma.module';
import { PrismaService } from '../src/common/prisma.service';
import { AuditService } from '../src/modules/audit/audit.service';
import { signToken } from '../src/modules/auth/auth.guard';
import { Vault } from '../src/modules/discovery/vault';
import { DispatcherService } from '../src/modules/integrations/dispatcher.service';
import { DispatcherModule } from '../src/modules/integrations/integrations.module';
import { verify } from '../src/modules/integrations/signing';
import { makeUser } from './fixtures';

/** A local webhook receiver whose replies the test scripts. */
class Receiver {
  server!: Server;
  url = '';
  requests: Array<{ headers: IncomingMessage['headers']; body: string; path: string }> = [];
  replies: number[] = [];
  async start() {
    this.server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        this.requests.push({ headers: req.headers, body, path: req.url ?? '' });
        res.statusCode = this.replies.shift() ?? 200;
        res.end(res.statusCode >= 400 ? 'receiver says no' : 'ok');
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

describe('Webhooks and outbox (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let dispatcher: DispatcherService;
  const prisma = new PrismaClient();
  const rx = new Receiver();
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    process.env.WEBHOOK_ALLOW_PRIVATE_CIDRS = '127.0.0.0/8';
    process.env.WEBHOOK_ALLOW_HTTP = 'true';
    await rx.start();
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    const dmod = await Test.createTestingModule({ imports: [PrismaModule, DispatcherModule] }).compile();
    dispatcher = dmod.get(DispatcherService);
    for (const role of ['admin', 'dc_technician', 'auditor'] as const) tokens[role] = signToken((await makeUser(prisma, role)).id);
    // Other spec files leave subscriptions behind only in their own DB state; start from a clean dispatch queue.
    await prisma.$executeRaw`DELETE FROM webhook_subscriptions`;
  });

  afterAll(async () => {
    await app.close();
    await rx.stop();
    await prisma.$disconnect();
  });

  const api = () => request(baseUrl);
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });
  const drain = async () => {
    // Make anything scheduled for later due now, then let the dispatcher send it.
    await prisma.$executeRaw`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status IN ('pending', 'failed')`;
    return dispatcher.tick();
  };
  const deliveries = (subId: string) => api().get(`/api/v1/webhooks/${subId}/deliveries`).set(as('admin')).expect(200).then((r) => r.body);

  let generic: { id: string; signingSecret: string };

  it('creates subscriptions; the signing secret is shown once and stored only sealed', async () => {
    const res = await api().post('/api/v1/webhooks').set(as('admin')).send({ name: 'Receiver', kind: 'generic', url: `${rx.url}/hook`, eventTypes: ['asset.*', 'discovery.conflict'] }).expect(201);
    generic = res.body;
    expect(generic.signingSecret).toMatch(/^whsec_/);
    const list = (await api().get('/api/v1/webhooks').set(as('admin')).expect(200)).body;
    expect(JSON.stringify(list)).not.toContain(generic.signingSecret);
    const row = await prisma.webhook_subscriptions.findUniqueOrThrow({ where: { id: generic.id } });
    expect(Buffer.from(row.secret_ciphertext).toString('utf8')).not.toContain(generic.signingSecret);

    const slack = (await api().post('/api/v1/webhooks').set(as('admin')).send({ name: 'Slack ops', kind: 'slack', eventTypes: ['discovery.*'], secret: { webhookUrl: 'https://hooks.slack.com/services/T000/B000/XXXX' } }).expect(201)).body;
    expect(slack.url).toBe('https://hooks.slack.com');

    expect((await api().post('/api/v1/webhooks').set(as('admin')).send({ name: 'Metadata', kind: 'generic', url: 'https://169.254.169.254/x', eventTypes: ['*'] }).expect(422)).body.code).toBe('WEBHOOK_URL_FORBIDDEN');
    expect((await api().post('/api/v1/webhooks').set(as('admin')).send({ name: 'Bad jira', kind: 'jira', url: 'https://acme.atlassian.net', eventTypes: ['*'], secret: { email: 'x@y.z', apiToken: 'abcdefgh' }, config: { projectKey: 'lowercase' } }).expect(400)).body.code).toBe('VALIDATION_FAILED');
    expect((await api().post('/api/v1/webhooks').set(as('admin')).send({ name: 'receiver', kind: 'generic', url: `${rx.url}/x`, eventTypes: ['*'] }).expect(409)).body.code).toBe('WEBHOOK_EXISTS');
    await api().get('/api/v1/webhooks').set(as('auditor')).expect(403);
    await api().delete(`/api/v1/webhooks/${slack.id}`).set(as('admin')).expect(204);
  });

  it('writes outbox events in the same transaction as the change, and fans out by pattern', async () => {
    const before = await prisma.outbox_events.count();
    // A rejected write (validation) leaves no event behind.
    await api().post('/api/v1/assets').set(as('dc_technician')).send({ name: '', type: 'switch' }).expect(400);
    expect(await prisma.outbox_events.count()).toBe(before);

    const asset = (await api().post('/api/v1/assets').set(as('dc_technician')).send({ name: 'edge-sw-01', type: 'switch' }).expect(201)).body;
    const ev = await prisma.outbox_events.findFirstOrThrow({ where: { entity_id: asset.id, type: 'asset.created' } });
    expect(ev.payload).toMatchObject({ after: { name: 'edge-sw-01' } });
    const d = await prisma.webhook_deliveries.findMany({ where: { event_id: ev.id } });
    expect(d.map((x) => x.subscription_id)).toEqual([generic.id]);
  });

  it('delivers signed requests and records success', async () => {
    rx.requests = [];
    expect(await drain()).toBeGreaterThanOrEqual(1);
    const got = rx.requests.find((r) => r.headers['x-itam-event'] === 'asset.created')!;
    expect(got.path).toBe('/hook');
    expect(verify(generic.signingSecret, got.body, String(got.headers['x-itam-signature']))).toBe(true);
    const body = JSON.parse(got.body);
    expect(body).toMatchObject({ type: 'asset.created', data: { after: { name: 'edge-sw-01' } } });
    const list = await deliveries(generic.id);
    expect(list.find((x: { id: string }) => x.id === got.headers['x-itam-delivery'])).toMatchObject({ status: 'succeeded', lastStatusCode: 200 });
  });

  it('retries server errors with backoff, gives up after the budget, and replays on demand', async () => {
    await api().post('/api/v1/assets').set(as('dc_technician')).send({ name: 'edge-sw-02', type: 'switch' }).expect(201);
    rx.replies = [503];
    await drain();
    let [latest] = await deliveries(generic.id);
    expect(latest).toMatchObject({ status: 'failed', attempts: 1, lastStatusCode: 503 });
    expect(Date.parse(latest.nextAttemptAt)).toBeGreaterThan(Date.now() + 15_000);

    await prisma.$executeRaw`UPDATE webhook_deliveries SET attempts = 11 WHERE id = ${BigInt(latest.id)}`;
    rx.replies = [500];
    await drain();
    [latest] = await deliveries(generic.id);
    expect(latest).toMatchObject({ status: 'dead', attempts: 12, lastError: expect.stringMatching(/gave up after 12 attempts/) });

    await api().post(`/api/v1/webhook-deliveries/${latest.id}/replay`).set(as('admin')).expect(202);
    expect((await api().post(`/api/v1/webhook-deliveries/${latest.id}/replay`).set(as('admin')).expect(409)).body.code).toBe('DELIVERY_PENDING');
    await drain();
    [latest] = await deliveries(generic.id);
    expect(latest).toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('does not retry a 4xx; the ping reaches only its own subscription', async () => {
    const other = (await api().post('/api/v1/webhooks').set(as('admin')).send({ name: 'Catch-all', kind: 'generic', url: `${rx.url}/all`, eventTypes: ['*'] }).expect(201)).body;
    await drain(); // "*" includes its own webhook.created event
    rx.requests = [];
    rx.replies = [410];
    const ping = (await api().post(`/api/v1/webhooks/${other.id}/test`).set(as('admin')).expect(202)).body;
    await drain();
    expect(rx.requests.map((r) => [r.path, r.headers['x-itam-event']])).toEqual([['/all', 'webhook.ping']]);
    const [d] = await deliveries(other.id);
    expect(d).toMatchObject({ id: ping.deliveryId, status: 'dead', lastStatusCode: 410 });
    await api().delete(`/api/v1/webhooks/${other.id}`).set(as('admin')).expect(204);
  });

  it('blocks a hostname that resolves to a private address at send time', async () => {
    const saved = process.env.WEBHOOK_ALLOW_PRIVATE_CIDRS;
    process.env.WEBHOOK_ALLOW_PRIVATE_CIDRS = '';
    const strict = new DispatcherService(app.get(PrismaService), app.get(Vault), app.get(AuditService));
    process.env.WEBHOOK_ALLOW_PRIVATE_CIDRS = saved;
    // Allowed at create time (a name, not an IP); "localhost" resolves to loopback when sent.
    const sneaky = (await api().post('/api/v1/webhooks').set(as('admin')).send({ name: 'Sneaky', kind: 'generic', url: `${rx.url.replace('127.0.0.1', 'localhost')}/x`, eventTypes: ['webhook.never'] }).expect(201)).body;
    rx.requests = [];
    await api().post(`/api/v1/webhooks/${sneaky.id}/test`).set(as('admin')).expect(202);
    await prisma.$executeRaw`UPDATE webhook_deliveries SET next_attempt_at = now() WHERE status IN ('pending', 'failed')`;
    await strict.tick();
    expect(rx.requests).toHaveLength(0);
    const [d] = await deliveries(sneaky.id);
    expect(d).toMatchObject({ status: 'dead', lastError: expect.stringMatching(/blocked: .*non-public/) });
  });

  it('emits contract.expiring once per day', async () => {
    const vendor = await prisma.vendors.create({ data: { name: 'Webhook Vendor' } });
    const today = new Date();
    await prisma.contracts.create({ data: { vendor_id: vendor.id, contract_type: 'support', contract_number: 'WH-1', start_date: new Date(Date.now() - 300 * 864e5), end_date: new Date(Date.now() + 10 * 864e5), notice_days: 30 } });
    const day = today.toISOString().slice(0, 10);
    const a = await dispatcher.emitScheduled(day);
    await dispatcher.emitScheduled(day);
    expect(a.contracts).toBeGreaterThanOrEqual(1);
    expect(await prisma.outbox_events.count({ where: { type: 'contract.expiring', dedupe_key: { startsWith: 'contract.expiring:' }, payload: { path: ['contractNumber'], equals: 'WH-1' } } })).toBe(1);
  });
});
