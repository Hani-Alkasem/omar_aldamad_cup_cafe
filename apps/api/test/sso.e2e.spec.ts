import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { signToken } from '../src/modules/auth/auth.guard';
import { groupsOf, loadMapping, resolveRole, resolveSiteNames } from '../src/modules/sessions/mapping';
import { LAB_ROLE_MAP, LAB_USERS, startLabIdp, type LabIdp } from '../scripts/lab-idp';
import { makeUser } from './fixtures';

const user = (sub: string) => LAB_USERS.find((u) => u.sub === sub)!;

describe('mapping', () => {
  const m = loadMapping({ OIDC_ROLE_MAP: JSON.stringify({ a: 'auditor', t: 'dc_technician', n: 'network_engineer' }), OIDC_SITE_MAP: JSON.stringify({ east: ['DC-East'], west: ['DC-West'] }) });
  it('takes the strongest mapped role and normalises Keycloak group paths', () => {
    expect(groupsOf({ groups: ['/t', '/a', 'x'] }, 'groups')).toEqual(['t', 'a', 'x']);
    expect(resolveRole(['a', 't'], m)).toBe('dc_technician');
    expect(resolveRole(['x'], m)).toBeNull();
    expect(resolveRole(['x'], { ...m, defaultRole: 'auditor' })).toBe('auditor');
  });
  it('unions mapped sites; no site group means unscoped', () => {
    expect(resolveSiteNames(['east', 'west'], m)).toEqual(['DC-East', 'DC-West']);
    expect(resolveSiteNames(['t'], m)).toBeNull();
  });
  it('rejects a mapping to an unknown role', () => {
    expect(() => loadMapping({ OIDC_ROLE_MAP: '{"g":"root"}' })).toThrow(/unknown role/);
  });
});

describe('SSO sessions and site scopes (e2e)', () => {
  let app: INestApplication;
  let baseUrl: string;
  let idp: LabIdp;
  const prisma = new PrismaClient();
  const racks: Record<string, string> = {};

  beforeAll(async () => {
    idp = await startLabIdp();
    Object.assign(process.env, {
      OIDC_ISSUER: idp.issuer,
      OIDC_CLIENT_ID: 'itam-web',
      OIDC_ROLE_MAP: JSON.stringify(LAB_ROLE_MAP),
      OIDC_SITE_MAP: JSON.stringify({ 'site-dc-east': ['DC-East'], 'site-nowhere': ['Nowhere'] }),
    });
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(mod.createNestApplication());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();

    for (const site of ['DC-East', `DC-Other-${randomUUID().slice(0, 4)}`]) {
      const s = await prisma.sites.upsert({ where: { name: site }, update: {}, create: { name: site } });
      const b = await prisma.buildings.create({ data: { site_id: s.id, name: 'B' } });
      const r = await prisma.rooms.create({ data: { building_id: b.id, name: 'R' } });
      racks[site.startsWith('DC-East') ? 'east' : 'other'] = (await prisma.racks.create({ data: { room_id: r.id, name: `rk-${randomUUID().slice(0, 6)}` } })).id;
    }
  });

  afterAll(async () => {
    await app.close();
    await idp.close();
    for (const k of ['OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_ROLE_MAP', 'OIDC_SITE_MAP']) delete process.env[k];
    await prisma.$disconnect();
  });

  const api = () => request(baseUrl);
  const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
  const login = async (sub: string, status: number, o?: Parameters<LabIdp['idToken']>[1]) =>
    api().post('/api/v1/auth/sessions').send({ idToken: await idp.idToken(user(sub), o) }).expect(status);
  const session = async (sub: string) => (await login(sub, 201)).body.sessionToken as string;
  const asset = (rackId: string | null, startU: number, name = `a-${randomUUID().slice(0, 6)}`) =>
    rackId ? { name, type: 'physical_server', rackId, startU, sizeU: 1, face: 'front', depth: 'full' } : { name, type: 'physical_server' };

  it('opens a session from a verified ID token and maps the role from groups', async () => {
    const res = await login('u-ada', 201);
    expect(res.body.sessionToken).toMatch(/^itams_/);
    expect(res.body.user).toMatchObject({ email: 'ada@lab.example.com', role: 'admin', siteIds: null });
    const me = (await api().get('/api/v1/auth/me').set(bearer(res.body.sessionToken)).expect(200)).body;
    expect(me).toMatchObject({ role: 'admin', authSource: 'oidc', ssoEnabled: true });
    const row = await prisma.sessions.findFirstOrThrow({ where: { user_id: me.id } });
    expect(Buffer.from(row.token_hash).toString('base64url')).not.toContain(res.body.sessionToken.slice(6));
  });

  it('refuses replayed, stale, foreign-audience and ungrouped tokens', async () => {
    const t = await idp.idToken(user('u-ari'));
    await api().post('/api/v1/auth/sessions').send({ idToken: t }).expect(201);
    expect((await api().post('/api/v1/auth/sessions').send({ idToken: t }).expect(401)).body.message).toMatch(/already used/);
    await login('u-ari', 401, { ageSec: 900 });
    await login('u-ari', 401, { aud: 'some-other-app' });
    const tampered = (await idp.idToken(user('u-ari'))).replace(/\.[^.]+$/, '.AAAA');
    await api().post('/api/v1/auth/sessions').send({ idToken: tampered }).expect(401);
    expect((await login('u-mallory', 403)).body.code).toBe('NO_ROLE');
  });

  it('adopts a pre-provisioned local user by email; the IdP decides the role', async () => {
    const local = await prisma.users.create({ data: { email: 'nour@lab.example.com', display_name: 'Nour (local)', role: 'auditor' } });
    const res = await login('u-nour', 201);
    expect(res.body.user).toMatchObject({ id: local.id, role: 'network_engineer' });
    const changed = await prisma.audit_logs.findFirst({ where: { entity: 'user', entity_id: local.id }, select: { before: true, after: true } });
    expect(changed).toMatchObject({ before: { role: 'auditor' }, after: { role: 'network_engineer' } });
  });

  it('scopes a technician to their site for writes, not for reads', async () => {
    const dana = await session('u-dana');
    const me = (await api().get('/api/v1/auth/me').set(bearer(dana)).expect(200)).body;
    expect(me.sites.map((s: { name: string }) => s.name)).toEqual(['DC-East']);

    const east = (await api().post('/api/v1/assets').set(bearer(dana)).send(asset(racks.east, 10)).expect(201)).body;
    expect((await api().post('/api/v1/assets').set(bearer(dana)).send(asset(racks.other, 10)).expect(403)).body.code).toBe('OUT_OF_SCOPE');
    expect((await api().post('/api/v1/assets').set(bearer(dana)).send(asset(null, 0)).expect(403)).body.message).toMatch(/unracked/i);

    const admin = await session('u-ada');
    const other = (await api().post('/api/v1/assets').set(bearer(admin)).send(asset(racks.other, 12)).expect(201)).body;
    await api().get(`/api/v1/assets/${other.id}`).set(bearer(dana)).expect(200);
    await api().patch(`/api/v1/assets/${other.id}`).set(bearer(dana)).send({ startU: 20 }).expect(403);
    await api().patch(`/api/v1/assets/${east.id}`).set(bearer(dana)).send({ rackId: racks.other, startU: 30 }).expect(403);
    await api().patch(`/api/v1/assets/${east.id}`).set(bearer(dana)).send({ startU: 11 }).expect(200);
    await api().post(`/api/v1/assets/${other.id}/ports/bulk`).set(bearer(dana)).send({ prefix: 'eth', count: 2 }).expect(403);
    await api().post(`/api/v1/assets/${east.id}/ports/bulk`).set(bearer(dana)).send({ prefix: 'eth', count: 2 }).expect(201);
    await api().delete(`/api/v1/assets/${other.id}`).set(bearer(dana)).expect(403);
  });

  it('refuses a login whose site groups match no site, instead of granting every site', async () => {
    const lost = { ...user('u-dana'), sub: 'u-lost', email: 'lost@lab.example.com', groups: ['itam-dc-techs', 'site-nowhere'] };
    const res = await api().post('/api/v1/auth/sessions').send({ idToken: await idp.idToken(lost) }).expect(401);
    expect(res.body.message).toMatch(/do not match any site/);
  });

  it('logout and admin revocation end sessions immediately', async () => {
    const t = await session('u-ari');
    await api().delete('/api/v1/auth/sessions/current').set(bearer(t)).expect(204);
    expect((await api().get('/api/v1/auth/me').set(bearer(t)).expect(401)).body.code).toBe('SESSION_EXPIRED');

    const dana = await session('u-dana');
    const danaId = (await api().get('/api/v1/auth/me').set(bearer(dana)).expect(200)).body.id;
    const admin = await session('u-ada');
    expect((await api().delete(`/api/v1/users/${danaId}/sessions`).set(bearer(admin)).expect(200)).body.revoked).toBeGreaterThanOrEqual(1);
    await api().get('/api/v1/auth/me').set(bearer(dana)).expect(401);
    await api().delete(`/api/v1/users/${danaId}/sessions`).set(bearer(dana)).expect(401);
  });

  it('manual scopes apply to JWT users too', async () => {
    const tech = await makeUser(prisma, 'dc_technician');
    const east = await prisma.racks.findUniqueOrThrow({ where: { id: racks.east }, include: { rooms: { include: { buildings: true } } } });
    const admin = await session('u-ada');
    await api().put(`/api/v1/users/${tech.id}/sites`).set(bearer(admin)).send({ siteIds: [east.rooms.buildings.site_id] }).expect(200);
    const jwt = signToken(tech.id);
    await api().post('/api/v1/assets').set(bearer(jwt)).send(asset(racks.other, 40)).expect(403);
    await api().post('/api/v1/assets').set(bearer(jwt)).send(asset(racks.east, 40)).expect(201);
  });
});
