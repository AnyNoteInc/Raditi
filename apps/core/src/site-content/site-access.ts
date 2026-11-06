import type { Prisma } from '@repo/db'
import type { SiteAccessKind } from '@repo/domain'

/**
 * Whether a site has its access of a kind as the content resolver reads it: exactly one row of
 * `credential_refs`. The index on `(site_id, kind)` is not unique, and two rows are no access —
 * the resolver refuses them — so the preview build and the release skill read the row with this
 * one rule (docs/plan/62-site-stacks.md, Т37).
 */
export async function hasSiteAccess(
  db: Pick<Prisma.TransactionClient, 'credentialRef'>,
  siteId: string,
  kind: SiteAccessKind,
): Promise<boolean> {
  return (await db.credentialRef.count({ where: { siteId, kind } })) === 1
}
