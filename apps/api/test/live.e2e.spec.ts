import 'reflect-metadata';
import http from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { signToken } from '../src/modules/auth/auth.guard';
import { EventsService } from '../src/modules/events/events.service';
import { makeUser } from './fixtures';

/** Minimal SSE client: collects parsed `change` events until closed. */
function subscribe(url: string, token: string) {
  const events: Array<{ type: string; entityId: string }> = [];
  let buf = '';
  const req = http.get(url, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } }, (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^event: change$/m.test(block)) events.push(JSON.parse(/^data: (.*)$/m.exec(block)![1]));
      }
    });
  });
  return { events, close: () => req.destroy(), status: new Promise<number>((r) => req.on('response', (res) => r(res.statusCode ?? 0))) };
}

const until = async (cond: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return cond();
};

describe('Live events, metrics, request ids (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prisma = new PrismaClient();
  const tokens: Record<string, string> = {};

  beforeAll(async () => {
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    for (const role of ['admin', 'dc_technician', 'auditor'] as const) tokens[role] = signToken((await makeUser(prisma, role)).id);
    await until(() => app.get(EventsService).connected);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const api = () => request(baseUrl);
  const as = (role: string) => ({ Authorization: `Bearer ${tokens[role]}` });

  it('streams committed changes, filtered by type, and never rolled-back ones', async () => {
    const assets = subscribe(`${baseUrl}/api/v1/events/stream?types=asset.*`, tokens.auditor);
    const runs = subscribe(`${baseUrl}/api/v1/events/stream?types=discovery_run.progress`, tokens.auditor);
    expect(await assets.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));

    const created = (await api().post('/api/v1/assets').set(as('dc_technician')).send({ name: `live-${randomUUID().slice(0, 6)}`, type: 'switch' }).expect(201)).body;
    await api().post('/api/v1/assets').set(as('dc_technician')).send({ name: '', type: 'switch' }).expect(400);
    expect(await until(() => assets.events.some((e) => e.entityId === created.id))).toBe(true);
    expect(assets.events.find((e) => e.entityId === created.id)).toMatchObject({ type: 'asset.created', entity: 'asset' });
    expect(runs.events).toHaveLength(0);
    assets.close();
    runs.close();
  });

  it('hides admin-only events (credentials) from other roles', async () => {
    const auditor = subscribe(`${baseUrl}/api/v1/events/stream?types=*`, tokens.auditor);
    const admin = subscribe(`${baseUrl}/api/v1/events/stream?types=*`, tokens.admin);
    await Promise.all([auditor.status, admin.status]);
    await new Promise((r) => setTimeout(r, 200));
    const c = (await api().post('/api/v1/credentials').set(as('admin')).send({ name: `live-${randomUUID().slice(0, 6)}`, kind: 'snmp_v2c', secret: { community: 'x' } }).expect(201)).body;
    expect(await until(() => admin.events.some((e) => e.entityId === c.id))).toBe(true);
    await new Promise((r) => setTimeout(r, 300));
    expect(auditor.events.some((e) => e.entityId === c.id)).toBe(false);
    auditor.close();
    admin.close();
  });

  it('rejects unauthenticated and malformed stream requests', async () => {
    await api().get('/api/v1/events/stream').expect(401);
    await api().get('/api/v1/events/stream?types=DROP%20TABLE').set(as('auditor')).expect(400);
    const ok = subscribe(`${baseUrl}/api/v1/events/stream?types=asset.*`, tokens.auditor);
    expect(await ok.status).toBe(200);
    ok.close();
  });

  it('exposes Prometheus metrics with route templates, optionally behind a token', async () => {
    await api().get('/api/v1/assets').set(as('auditor')).expect(200);
    const m = await api().get('/api/v1/metrics').expect(200);
    expect(m.headers['content-type']).toMatch(/text\/plain/);
    expect(m.text).toMatch(/itam_http_request_duration_seconds_count\{method="GET",route="\/api\/v1\/assets",status="200"\} \d+/);
    expect(m.text).toContain('itam_webhook_backlog');
    expect(m.text).toContain('itam_process_cpu_seconds_total');
    process.env.METRICS_TOKEN = 'scrape-secret';
    try {
      await api().get('/api/v1/metrics').expect(401);
      await api().get('/api/v1/metrics').set('authorization', 'Bearer scrape-secret').expect(200);
    } finally {
      delete process.env.METRICS_TOKEN;
    }
  });

  it('echoes a well-formed X-Request-Id, replaces a bad one, and stamps it on audit rows', async () => {
    const mine = `req-${randomUUID()}`;
    const r = await api().post('/api/v1/assets').set(as('dc_technician')).set('x-request-id', mine).send({ name: `rid-${randomUUID().slice(0, 6)}`, type: 'switch' }).expect(201);
    expect(r.headers['x-request-id']).toBe(mine);
    expect((await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: r.body.id } })).request_id).toBe(mine);
    const bad = await api().get('/api/v1/assets').set(as('auditor')).set('x-request-id', 'x'.repeat(300)).expect(200);
    expect(bad.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
