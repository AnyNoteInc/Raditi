import type { Prisma } from '@repo/db'
import type { SiteAccessKind, SiteStack } from '@repo/domain'
import { findSiteContentAdapter } from '@repo/site-adapters'

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

/**
 * The kind of access the content plugin of a stack reads (`SiteContentAdapter.accessKind`); null —
 * the stack has no published content, and no plugin to deliver a plan with (docs/plan/62-site-stacks.md,
 * Т8). One rule for every place that asks: `findSiteContentAdapter`, so an unknown stack throws
 * as the registry does, and no other failure is taken for «no plugin».
 */
export function contentAccessKindOf(stack: SiteStack): SiteAccessKind | null {
  return findSiteContentAdapter(stack)?.accessKind ?? null
}
