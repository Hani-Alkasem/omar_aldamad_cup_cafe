import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { signToken } from '../src/modules/auth/auth.guard';
import { hashSecret, verifySecret } from '../src/modules/service-clients/secrets';
import { makeUser } from './fixtures';

describe('Service clients and token exchange (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  const prisma = new PrismaClient();
  let admin: string;

  beforeAll(async () => {
    process.env.SERVICE_CLIENT_CACHE_MS = '0'; // revocation applies immediately in tests
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    admin = signToken((await makeUser(prisma, 'admin')).id);
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  const api = () => request(baseUrl);
  const as = (t: string) => ({ Authorization: `Bearer ${t}` });
  const token = (clientId: string, clientSecret: string) => api().post('/api/v1/auth/token').send({ clientId, clientSecret });
  const create = async (name: string) => (await api().post('/api/v1/service-clients').set(as(admin)).send({ name }).expect(201)).body;

  it('hashes with scrypt and verifies in constant time', async () => {
    const h = await hashSecret('itamcs_example');
    expect(h).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(await verifySecret('itamcs_example', h)).toBe(true);
    expect(await verifySecret('itamcs_other', h)).toBe(false);
  });

  it('issues a short-lived token that works on internal routes only, and never stores the secret', async () => {
    const c = await create(`worker-${randomUUID().slice(0, 6)}`);
    expect(c.clientSecret).toMatch(/^itamcs_/);
    const row = await prisma.service_clients.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.secret_hash).not.toContain(c.clientSecret);
    expect(JSON.stringify((await api().get('/api/v1/service-clients').set(as(admin)).expect(200)).body)).not.toContain(c.clientSecret);

    const t = (await token(c.id, c.clientSecret).expect(200)).body;
    expect(t).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
    // The machine role is confined to internal routes by the guard.
    await api().get('/api/v1/assets').set(as(t.accessToken)).expect(403);
    expect((await api().post(`/api/v1/internal/discovery/runs/${randomUUID()}/claim`).set(as(t.accessToken)).expect(404)).body.code).toBe('NOT_FOUND');
    expect((await prisma.service_clients.findUniqueOrThrow({ where: { id: c.id } })).last_used_at).not.toBeNull();
  });

  it('gives one answer for every failure and audits denials', async () => {
    const c = await create(`worker-${randomUUID().slice(0, 6)}`);
    const wrong = await token(c.id, 'itamcs_wrong-secret-value').expect(401);
    const unknown = await token(randomUUID(), 'itamcs_wrong-secret-value').expect(401);
    expect(wrong.body.code).toBe('INVALID_CLIENT');
    expect(unknown.body.message).toBe(wrong.body.message);
    const denied = await prisma.audit_logs.findMany({ where: { entity_id: c.id, action: 'access' }, select: { after: true } });
    expect(denied).toMatchObject([{ after: { result: 'denied', reason: 'bad secret' } }]);
  });

  it('rotation kills the old secret and old tokens; revocation kills everything', async () => {
    const c = await create(`worker-${randomUUID().slice(0, 6)}`);
    const old = (await token(c.id, c.clientSecret).expect(200)).body.accessToken;
    await new Promise((r) => setTimeout(r, 1100)); // tokens carry second-precision iat
    const rotated = (await api().post(`/api/v1/service-clients/${c.id}/rotate`).set(as(admin)).expect(200)).body;
    await token(c.id, c.clientSecret).expect(401);
    expect((await api().post(`/api/v1/internal/discovery/runs/${randomUUID()}/claim`).set(as(old)).expect(401)).body.message).toMatch(/rotated/);
    await new Promise((r) => setTimeout(r, 1100));
    const fresh = (await token(c.id, rotated.clientSecret).expect(200)).body.accessToken;
    await api().post(`/api/v1/internal/discovery/runs/${randomUUID()}/claim`).set(as(fresh)).expect(404);

    await api().delete(`/api/v1/service-clients/${c.id}`).set(as(admin)).expect(204);
    await api().post(`/api/v1/internal/discovery/runs/${randomUUID()}/claim`).set(as(fresh)).expect(401);
    await token(c.id, rotated.clientSecret).expect(401);
    expect((await api().post(`/api/v1/service-clients/${c.id}/rotate`).set(as(admin)).expect(409)).body.code).toBe('SERVICE_CLIENT_REVOKED');
  });

  it('rate-limits repeated failures per client', async () => {
    const c = await create(`worker-${randomUUID().slice(0, 6)}`);
    for (let i = 0; i < 10; i++) await token(c.id, 'itamcs_wrong-secret-value').expect(401);
    const res = await token(c.id, c.clientSecret).expect(429);
    expect(res.body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS', details: { retryAfterSeconds: expect.any(Number) } });
  });

  it('is admin-only to manage', async () => {
    const tech = signToken((await makeUser(prisma, 'dc_technician')).id);
    await api().get('/api/v1/service-clients').set(as(tech)).expect(403);
    await api().post('/api/v1/service-clients').set(as(tech)).send({ name: 'x' }).expect(403);
  });
});
