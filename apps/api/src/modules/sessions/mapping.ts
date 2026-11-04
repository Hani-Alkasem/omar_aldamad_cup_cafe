import type { HumanRole } from '@itam/shared';

/** Most privileged first: a user in several mapped groups gets the strongest role. */
const ORDER: HumanRole[] = ['admin', 'network_engineer', 'dc_technician', 'auditor'];

export interface ClaimMapping {
  groupsClaim: string;
  roleMap: Record<string, HumanRole>;
  /** IdP group → site names the members may change. A user in no mapped site group is unscoped. */
  siteMap: Record<string, string[]>;
  defaultRole: HumanRole | null;
}

function parseJson<T>(name: string, text: string | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${name} must be JSON`);
  }
}

export function loadMapping(env: NodeJS.ProcessEnv = process.env): ClaimMapping {
  const roleMap = parseJson<Record<string, HumanRole>>('OIDC_ROLE_MAP', env.OIDC_ROLE_MAP, {});
  for (const [g, r] of Object.entries(roleMap)) if (!ORDER.includes(r)) throw new Error(`OIDC_ROLE_MAP: ${g} maps to unknown role ${r}`);
  const def = (env.OIDC_DEFAULT_ROLE || null) as HumanRole | null;
  if (def && !ORDER.includes(def)) throw new Error(`OIDC_DEFAULT_ROLE ${def} is not a role`);
  return { groupsClaim: env.OIDC_GROUPS_CLAIM || 'groups', roleMap, siteMap: parseJson('OIDC_SITE_MAP', env.OIDC_SITE_MAP, {}), defaultRole: def };
}

/** Keycloak prefixes group paths with "/"; Entra sends GUIDs; some IdPs send a single string. */
export function groupsOf(claims: Record<string, unknown>, claim: string): string[] {
  const raw = claims[claim];
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[ ,]+/) : [];
  return [...new Set(list.filter((g): g is string => typeof g === 'string' && g.length > 0).map((g) => g.replace(/^\//, '')))];
}

/** null: no mapped group and no default role, so the login is refused. */
export function resolveRole(groups: string[], m: ClaimMapping): HumanRole | null {
  const roles = groups.map((g) => m.roleMap[g]).filter(Boolean);
  return ORDER.find((r) => roles.includes(r)) ?? m.defaultRole;
}

/** null means unscoped (every site). */
export function resolveSiteNames(groups: string[], m: ClaimMapping): string[] | null {
  const names = groups.flatMap((g) => m.siteMap[g] ?? []);
  return names.length ? [...new Set(names)].sort() : null;
}
