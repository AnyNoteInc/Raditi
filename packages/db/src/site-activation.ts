import { badRequest, siteAccessKinds, siteAccessPath, type SiteAccessKind } from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'

type ActivationDatabase = Pick<Prisma.TransactionClient, '$queryRaw'>

const inputSchema = z.strictObject({
  siteId: z.uuid(),
  requiredAccess: z
    .array(z.enum(siteAccessKinds))
    .min(1)
    .max(siteAccessKinds.length)
    .refine((kinds) => new Set(kinds).size === kinds.length),
})
const rowsSchema = z.array(
  z.object({
    status: z.string(),
    access: z.array(z.enum(siteAccessKinds)),
    repository: z.boolean(),
    activated: z.boolean(),
  }),
)

export interface SiteActivationInput {
  siteId: string
  /**
   * Kinds of access the site cannot be worked on without. The adapters of its stack name them
   * (`SiteContentAdapter.accessKind` and, later, the deploy access); this code compares no stack.
   */
  requiredAccess: readonly SiteAccessKind[]
}

export type SiteActivationResult =
  | { status: 'activated' }
  /** A repeated connection: the site was active before the call and is not touched. */
  | { status: 'already_active' }
  | { status: 'refused'; reason: 'not_found' | 'status' | 'repository' }
  /** `access` lists the kinds without a usable reference, in the order they were asked for. */
  | { status: 'refused'; reason: 'access'; access: SiteAccessKind[] }

/**
 * The end of connecting a site (spec §12): `onboarding → active`, in one statement and only
 * when the site has what a turn needs — a repository and, for every named kind of access, the
 * reference its reader will follow: the only `credential_refs` row of that kind of the site, in
 * the site's workspace, at `kv/sites/<siteId>/<kind>`, with a written version. Whether the
 * secret itself is in Vault is the business of the step that wrote it: the database only
 * points. No other status is left this way; a paused or archived site stays as it is.
 */
export async function activateSite(
  db: ActivationDatabase,
  input: SiteActivationInput,
): Promise<SiteActivationResult> {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) throw badRequest('Invalid site activation input')
  const { siteId, requiredAccess } = parsed.data
  const paths = requiredAccess.map((kind) => siteAccessPath(siteId, kind))
  // The row lock serializes concurrent connections of one site: the loser sees `active`.
  const rows = rowsSchema.safeParse(
    await db.$queryRaw`
      WITH target AS MATERIALIZED (
        SELECT id, workspace_id, status FROM sites WHERE id = ${siteId}::uuid FOR UPDATE
      ),
      facts AS (
        SELECT t.id, t.status::text AS status,
          COALESCE((
            SELECT array_agg(need.kind ORDER BY need.position)
            FROM unnest(${[...requiredAccess]}::text[], ${paths}::text[])
              WITH ORDINALITY AS need(kind, path, position)
            WHERE (SELECT count(*) FROM credential_refs c
                WHERE c.site_id = t.id AND c.kind::text = need.kind) <> 1
              OR NOT EXISTS (SELECT 1 FROM credential_refs c
                WHERE c.site_id = t.id AND c.kind::text = need.kind
                  AND c.workspace_id = t.workspace_id AND c.vault_path = need.path
                  AND c.key_version >= 1)
          ), '{}') AS access,
          EXISTS (SELECT 1 FROM git_repositories g WHERE g.site_id = t.id) AS repository
        FROM target t
      ),
      activated AS (
        UPDATE sites s SET status = 'active', updated_at = clock_timestamp()
        FROM facts f
        WHERE s.id = f.id AND f.status = 'onboarding' AND cardinality(f.access) = 0
          AND f.repository
        RETURNING s.id
      )
      SELECT f.status, f.access, f.repository, EXISTS (SELECT 1 FROM activated) AS activated
      FROM facts f`,
  )
  if (!rows.success) throw badRequest('Invalid site activation answer returned by the database')
  const row = rows.data[0]
  if (!row) return { status: 'refused', reason: 'not_found' }
  if (row.activated) return { status: 'activated' }
  if (row.status === 'active') return { status: 'already_active' }
  if (row.status !== 'onboarding') return { status: 'refused', reason: 'status' }
  if (row.access.length > 0) return { status: 'refused', reason: 'access', access: row.access }
  if (!row.repository) return { status: 'refused', reason: 'repository' }
  throw badRequest('Invalid site activation answer returned by the database')
}
