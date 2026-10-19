import {
  assertReleaseTransition,
  releaseResolutions,
  type ReleaseResolution,
  type ReleaseStatus,
} from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'
import { returnReleaseFromOperator } from './release-leases.ts'
import { wakeRelease } from './release-records.ts'

// `releases:resolve` (docs/plan/53-chat-preview-release.md, Р31, «Маршруты»): an operator who
// found out what the hosting holds decides an `unknown` release. Only the decision is written
// here; the release skill of core then ends the release as for any other end — the revert
// commit after `rolled_back`, the installed version after `installed` — and frees the site.
// The same command hands back an ended release whose revert commit could not land (Р27: `main`
// stood elsewhere, or git refused): the operator put `main` back and says the hosting holds the
// old version (`rolled_back`); core then pushes the revert commit, or takes `main` as it is
// when it holds the installed tree, and ends the release. Both only once core gave the site to
// the operator (the lease held for the operator under the release's barrier): before that core
// is still trying by itself.

export const RELEASE_RESOLVE_AUDIT_ACTION = 'release.resolve'

const oneLine = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !/\p{Cc}/u.test(value))

const inputSchema = z.strictObject({
  releaseId: z.uuid(),
  outcome: z.enum(releaseResolutions),
  operator: oneLine(128),
  /** audit_log.meta holds it. */
  reason: oneLine(500),
})
export type ReleaseResolveInput = z.input<typeof inputSchema>

export type ReleaseResolveResult =
  /** Decided now: the release goes on in core. */
  | { kind: 'resolved'; status: ReleaseResolution; siteId: string; version: string }
  /** The same decision was written before. */
  | { kind: 'repeated'; status: ReleaseResolution; siteId: string; version: string }
  /** An ended release whose revert commit could not land: core tries it again. */
  | { kind: 'revert_retried'; status: ReleaseStatus; siteId: string; version: string }
  /** `unknown`, but core has not handed the site to the operator yet: it is still trying. */
  | { kind: 'not_held'; status: ReleaseStatus }
  /** The release is not waiting for an operator. */
  | { kind: 'refused'; status: ReleaseStatus }
  | { kind: 'not_found' }

/**
 * Writes the operator's decision about a release held for the operator in one transaction: the
 * status (of an `unknown` one), the lease handed back to the release, an audit entry and a
 * wake-up of `release.advance`.
 */
export async function resolveRelease(
  db: Pick<Prisma.TransactionClient, '$queryRaw' | 'outboxEvent' | 'auditLog'>,
  input: ReleaseResolveInput,
): Promise<ReleaseResolveResult> {
  const { releaseId, outcome, operator, reason } = inputSchema.parse(input)
  const rows = z
    .array(
      z.object({
        status: z.string(),
        site_id: z.uuid(),
        version: z.string(),
        workspace_id: z.uuid(),
        revert_open: z.boolean(),
        held: z.boolean(),
      }),
    )
    .parse(
      await db.$queryRaw`
        SELECT r.status::text AS status, r.site_id, r.version, s.workspace_id,
          (r.main_pushed_at IS NOT NULL AND r.revert_sha IS NULL) AS revert_open,
          COALESCE(l.inflight_release_id = r.id AND l.held_for_operator, false) AS held
        FROM site_releases r JOIN sites s ON s.id = r.site_id
        LEFT JOIN site_leases l ON l.site_id = r.site_id
        WHERE r.id = ${releaseId}::uuid
        FOR UPDATE OF r`,
    )
  const row = rows[0]
  if (!row) return { kind: 'not_found' }
  const status = row.status as ReleaseStatus
  const facts = { siteId: row.site_id, version: row.version }
  const handBack = async (retry: boolean) => {
    // The lease held for the operator goes back to the release; core ends it from its row.
    await returnReleaseFromOperator(db, { releaseId })
    await db.auditLog.create({
      data: {
        actorType: 'operator',
        actorId: operator,
        workspaceId: row.workspace_id,
        action: RELEASE_RESOLVE_AUDIT_ACTION,
        targetType: 'release',
        targetId: releaseId,
        meta: retry ? { outcome, reason, retry: 'revert' } : { outcome, reason },
      },
    })
    await wakeRelease(db, { releaseId })
  }
  // Ended without `installed`, its revert commit held back: the hosting holds the old version.
  if ((status === 'failed' || status === 'rolled_back') && row.held && row.revert_open) {
    if (outcome !== 'rolled_back') return { kind: 'refused', status }
    await handBack(true)
    return { kind: 'revert_retried', status, ...facts }
  }
  if (status === outcome) {
    const decided = await db.auditLog.count({
      where: { action: RELEASE_RESOLVE_AUDIT_ACTION, targetType: 'release', targetId: releaseId },
    })
    if (decided > 0) return { kind: 'repeated', status: outcome, ...facts }
  }
  if (status !== 'unknown') return { kind: 'refused', status }
  if (!row.held) return { kind: 'not_held', status }
  assertReleaseTransition('unknown', outcome)
  await db.$queryRaw`
    UPDATE site_releases SET status = ${outcome}::"ReleaseStatus", updated_at = clock_timestamp()
    WHERE id = ${releaseId}::uuid AND status = 'unknown'
    RETURNING id`
  await handBack(false)
  return { kind: 'resolved', status: outcome, ...facts }
}
