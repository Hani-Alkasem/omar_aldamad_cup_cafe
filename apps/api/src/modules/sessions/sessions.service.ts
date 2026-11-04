import { createHash, randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { HumanRole, Role } from '@itam/shared';
import { DomainError, notFound } from '../../common/errors';
import { PrismaService, TX_OPTIONS } from '../../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { groupsOf, loadMapping, resolveRole, resolveSiteNames, type ClaimMapping } from './mapping';
import { OidcVerifier } from './oidc';

export const SESSION_PREFIX = 'itams_';
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const minutes = (env: string | undefined, def: number) => Number(env ?? def) * 60_000;

export interface SessionUser {
  id: string;
  email: string;
  role: Role;
  siteIds: string[] | null;
  sessionId: string;
}

@Injectable()
export class SessionsService {
  private readonly log = new Logger('Sessions');
  readonly oidc = OidcVerifier.fromEnv();
  private readonly mapping: ClaimMapping = loadMapping();
  private readonly idleMs = minutes(process.env.SESSION_IDLE_MINUTES, 120);
  private readonly absoluteMs = minutes(process.env.SESSION_MAX_MINUTES, 720);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private refuse(msg: string, code = 'LOGIN_REFUSED') {
    return new DomainError(HttpStatus.UNAUTHORIZED, code, msg);
  }

  /**
   * Exchange a fresh, verified ID token for an opaque session. Role and site scopes come from the
   * IdP's group claim on every login, so removing someone from a group takes effect at next login
   * (and immediately if an admin revokes their sessions).
   */
  async createFromIdToken(idToken: string, meta: { ip?: string; userAgent?: string }) {
    if (!this.oidc) throw new DomainError(HttpStatus.NOT_FOUND, 'SSO_DISABLED', 'Single sign-on is not configured');
    let claims;
    try {
      claims = await this.oidc.verify(idToken);
    } catch (e) {
      this.log.warn(`ID token rejected: ${(e as Error).message}`);
      throw this.refuse('The identity provider token could not be verified');
    }
    const email = typeof claims.email === 'string' ? claims.email : typeof claims.preferred_username === 'string' && claims.preferred_username.includes('@') ? claims.preferred_username : null;
    if (!email) throw this.refuse('The identity provider did not send an email address (request the "email" scope)');
    const groups = groupsOf(claims, this.mapping.groupsClaim);
    const role = resolveRole(groups, this.mapping);
    if (!role) throw new DomainError(HttpStatus.FORBIDDEN, 'NO_ROLE', 'Your account is not in any group that grants access to ITAM');
    const siteNames = resolveSiteNames(groups, this.mapping);
    const name = typeof claims.name === 'string' ? claims.name : email;

    const token = `${SESSION_PREFIX}${randomBytes(32).toString('base64url')}`;
    const expiresAt = new Date(Date.now() + this.absoluteMs);
    return this.prisma.$transaction(async (tx) => {
      const issuer = this.oidc!.issuer;
      // Link by IdP subject; on first login, adopt a pre-provisioned local user with the same email.
      let user = await tx.users.findFirst({ where: { external_issuer: issuer, external_subject: claims.sub! } });
      if (!user) {
        const byEmail = await tx.users.findFirst({ where: { email: { equals: email, mode: 'insensitive' } } });
        if (byEmail?.auth_source === 'service') throw this.refuse('That email belongs to a service account');
        if (byEmail?.auth_source === 'oidc') throw this.refuse('That email is linked to a different identity provider account');
        user = byEmail
          ? await tx.users.update({ where: { id: byEmail.id }, data: { auth_source: 'oidc', external_issuer: issuer, external_subject: claims.sub! } })
          : await tx.users.create({ data: { email, display_name: name, role, auth_source: 'oidc', external_issuer: issuer, external_subject: claims.sub! } });
      }
      if (!user.is_active) throw this.refuse('Your ITAM account is disabled');
      const before = { role: user.role };
      user = await tx.users.update({ where: { id: user.id }, data: { role, display_name: name, email, last_login_at: new Date() } });

      // IdP-sourced scopes are replaced on each login; scopes an admin set by hand are kept.
      await tx.user_site_scopes.deleteMany({ where: { user_id: user.id, source: 'oidc' } });
      if (siteNames) {
        const sites = await tx.sites.findMany({ where: { name: { in: siteNames } }, select: { id: true, name: true } });
        const unknown = siteNames.filter((n) => !sites.some((s) => s.name === n));
        if (unknown.length) this.log.warn(`OIDC_SITE_MAP names unknown sites: ${unknown.join(', ')}`);
        // A scoped group whose sites do not exist must not silently become "all sites".
        if (!sites.length) throw this.refuse('Your site groups do not match any site in ITAM');
        await tx.user_site_scopes.createMany({ data: sites.map((s) => ({ user_id: user!.id, site_id: s.id, source: 'oidc' })), skipDuplicates: true });
      }

      let session;
      try {
        session = await tx.sessions.create({
          data: { token_hash: sha256(token), id_token_hash: sha256(idToken), user_id: user.id, expires_at: expiresAt, ip: meta.ip?.slice(0, 64), user_agent: meta.userAgent?.slice(0, 300) },
        });
      } catch {
        throw this.refuse('That sign-in was already used; sign in again');
      }
      await this.audit.record(tx, { entity: 'session', entityId: session.id, action: 'create', after: { userId: user.id, role, groups, siteNames, ip: meta.ip }, userId: user.id });
      if (before.role !== role) {
        await this.audit.record(tx, { entity: 'user', entityId: user.id, action: 'update', before, after: { role, source: 'oidc groups' }, userId: user.id });
      }
      const siteIds = (await tx.user_site_scopes.findMany({ where: { user_id: user.id }, select: { site_id: true } })).map((s) => s.site_id);
      return { sessionToken: token, expiresAt: expiresAt.toISOString(), user: { id: user.id, email: user.email, name: user.display_name, role: user.role as HumanRole, siteIds: siteIds.length ? siteIds : null } };
    }, TX_OPTIONS);
  }

  /** Guard path: opaque token → active user. Idle sessions lapse; last_seen is touched at most once a minute. */
  async resolve(token: string): Promise<SessionUser | null> {
    const [s] = await this.prisma.$queryRaw<Array<{ id: string; user_id: string; last_seen_at: Date; expires_at: Date; email: string; role: Role; is_active: boolean; site_ids: string[] | null }>>`
      SELECT s.id, s.user_id, s.last_seen_at, s.expires_at, u.email, u.role, u.is_active,
             (SELECT array_agg(site_id) FROM user_site_scopes WHERE user_id = u.id) AS site_ids
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ${sha256(token)} AND s.revoked_at IS NULL`;
    const now = Date.now();
    if (!s || !s.is_active || s.expires_at.getTime() <= now || now - s.last_seen_at.getTime() > this.idleMs) return null;
    if (now - s.last_seen_at.getTime() > 60_000) {
      await this.prisma.sessions.update({ where: { id: s.id }, data: { last_seen_at: new Date() } });
    }
    return { id: s.user_id, email: s.email, role: s.role, siteIds: s.site_ids, sessionId: s.id };
  }

  async revoke(sessionId: string, user: AuthUser) {
    await this.prisma.$transaction(async (tx) => {
      const r = await tx.sessions.updateMany({ where: { id: sessionId, user_id: user.id, revoked_at: null }, data: { revoked_at: new Date() } });
      if (r.count) await this.audit.record(tx, { entity: 'session', entityId: sessionId, action: 'delete', before: { userId: user.id }, userId: user.id });
    }, TX_OPTIONS);
  }

  /** Admin kill switch: sign a user out everywhere now. */
  async revokeAll(userId: string, admin: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.users.findUnique({ where: { id: userId }, select: { id: true } }))) throw notFound('User', userId);
      const r = await tx.sessions.updateMany({ where: { user_id: userId, revoked_at: null }, data: { revoked_at: new Date() } });
      await this.audit.record(tx, { entity: 'user', entityId: userId, action: 'update', before: { activeSessions: r.count }, after: { activeSessions: 0 }, userId: admin.id });
      return { revoked: r.count };
    }, TX_OPTIONS);
  }

  async me(user: AuthUser) {
    const u = await this.prisma.users.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, email: true, display_name: true, role: true, auth_source: true, user_site_scopes: { select: { sites: { select: { id: true, name: true } } } } } });
    return { id: u.id, email: u.email, name: u.display_name, role: u.role, authSource: u.auth_source, sites: u.user_site_scopes.map((s) => s.sites), ssoEnabled: Boolean(this.oidc) };
  }

  async setSites(userId: string, siteIds: string[], admin: AuthUser) {
    return this.prisma.$transaction(async (tx) => {
      if (!(await tx.users.findUnique({ where: { id: userId }, select: { id: true } }))) throw notFound('User', userId);
      const found = await tx.sites.findMany({ where: { id: { in: siteIds } }, select: { id: true } });
      const missing = siteIds.find((id) => !found.some((f) => f.id === id));
      if (missing) throw notFound('Site', missing);
      const before = (await tx.user_site_scopes.findMany({ where: { user_id: userId, source: 'manual' } })).map((s) => s.site_id);
      await tx.user_site_scopes.deleteMany({ where: { user_id: userId, source: 'manual' } });
      await tx.user_site_scopes.createMany({ data: siteIds.map((site_id) => ({ user_id: userId, site_id, source: 'manual' })), skipDuplicates: true });
      await this.audit.record(tx, { entity: 'user', entityId: userId, action: 'update', before: { manualSites: before }, after: { manualSites: siteIds }, userId: admin.id });
      return { userId, siteIds };
    }, TX_OPTIONS);
  }
}
