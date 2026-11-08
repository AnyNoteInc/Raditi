import { badRequest, siteStackFactsPatchSchema, type SiteStackFactsPatch } from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'

// The one writer of `sites.stack_facts` (docs/plan/62-site-stacks.md, Т13): the wizard, the
// import, a fresh copy and the trial boot each write their part, and `||` keeps the keys of the
// others. It does not merge nested objects: a part with `extras` replaces them as a whole. The
// record is read only through `siteStackFactsOf` of the domain.

const siteIdSchema = z.uuid()

/** Writes one part of the record of a site. An empty part sends no query. */
export async function mergeSiteStackFacts(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  siteId: string,
  patch: SiteStackFactsPatch,
): Promise<void> {
  const parsed = siteStackFactsPatchSchema.safeParse(patch)
  if (!parsed.success || !siteIdSchema.safeParse(siteId).success)
    throw badRequest('Invalid facts of a site')
  const part = Object.fromEntries(
    Object.entries(parsed.data).filter(([, value]) => value !== undefined),
  )
  if (Object.keys(part).length === 0) return
  const json = JSON.stringify({ v: 1, ...part })
  await db.$executeRaw`
    UPDATE sites SET stack_facts = stack_facts || ${json}::jsonb, updated_at = now()
    WHERE id = ${siteId}::uuid`
}
