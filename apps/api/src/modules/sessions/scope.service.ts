import { HttpStatus, Injectable } from '@nestjs/common';
import { DomainError } from '../../common/errors';
import type { Tx } from '../../common/prisma.service';
import type { AuthUser } from '../auth/auth.types';

const outOfScope = (what: string) =>
  new DomainError(HttpStatus.FORBIDDEN, 'OUT_OF_SCOPE', `${what} is outside the sites you may change`);

/**
 * Site scoping for writes. Reads stay global (an auditor or a technician may look anywhere);
 * changes to physical inventory are limited to the user's sites. Unscoped users (no scope rows,
 * which includes every admin by default) pass every check.
 *
 * A scoped user cannot create or change unracked assets: "in my data centre" needs a rack to prove it.
 */
@Injectable()
export class ScopeService {
  private scoped(user: AuthUser): Set<string> | null {
    return user.siteIds?.length ? new Set(user.siteIds) : null;
  }

  async assertAssets(tx: Tx, user: AuthUser, assetIds: string[]) {
    const allowed = this.scoped(user);
    if (!allowed || !assetIds.length) return;
    const rows = await tx.$queryRaw<Array<{ id: string; name: string; site: string | null }>>`
      SELECT a.id, a.name, asset_site(a.id) AS site FROM assets a WHERE a.id = ANY(${assetIds}::uuid[])`;
    const bad = rows.find((r) => !r.site || !allowed.has(r.site));
    if (bad) throw outOfScope(bad.site ? bad.name : `${bad.name} (not in a rack)`);
  }

  /** Placing into (or creating in) a rack. rackId null means unracked. */
  async assertRack(tx: Tx, user: AuthUser, rackId: string | null | undefined) {
    const allowed = this.scoped(user);
    if (!allowed) return;
    if (!rackId) throw outOfScope('An unracked asset');
    const [r] = await tx.$queryRaw<Array<{ site: string | null; name: string }>>`SELECT rack_site(${rackId}::uuid) AS site, name FROM racks WHERE id = ${rackId}::uuid`;
    if (r && (!r.site || !allowed.has(r.site))) throw outOfScope(`Rack ${r.name}`);
  }
}
