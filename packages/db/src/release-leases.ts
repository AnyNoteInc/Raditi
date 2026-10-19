import { releaseStatuses, type ReleaseStatus } from '@repo/domain'
import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'

// The site lease of a release (docs/plan/53-chat-preview-release.md, Р9, Р27, R8b). A release
// holds the lease `deploy` of its site from its readiness to its end, and the barrier
// `site_leases.inflight_release_id` from the readiness on: `acquire` refuses while it stands,
// even under an expired lease, and `release`/`free` of the lease store leave it alone. So the
// release moves its own lease with these statements, never through the lease store: each run
// of `release.advance` takes the lease over at the next epoch together with
// `site_releases.lease_epoch` (as a recovered turn takes its lease over with its assignment),
// and a run that finds the epoch moved is not the newest one and stops.

type Db = Pick<Prisma.TransactionClient, '$queryRaw'>

const id = z.uuid()
const epochSchema = z.number().int().positive().max(2_147_483_647)
const ttlSchema = z
  .number()
  .int()
  .min(1_000)
  .max(30 * 60_000)

export interface ReleaseLease {
  siteId: string
  taskId: string
  epoch: number
  expiresAt: Date
}

const leaseRows = z.array(
  z.object({
    site_id: id,
    task_id: id,
    epoch: epochSchema,
    expires_at: z.coerce.date(),
  }),
)

const leaseOf = (raw: unknown): ReleaseLease | null => {
  const row = leaseRows.parse(raw)[0]
  return row
    ? { siteId: row.site_id, taskId: row.task_id, epoch: row.epoch, expiresAt: row.expires_at }
    : null
}

/**
 * Takes the deploy lease of a release over at the next epoch, together with
 * `site_releases.lease_epoch`, in one statement. The lease must still be the release's own —
 * its task, `deploy`, the epoch the row names, not held for an operator — and, once the barrier
 * stands, under the barrier of this release (before it, only while the release is `approved`).
 * An expired lease is taken over as well: before the barrier nobody acquired it meanwhile (its
 * epoch would have moved), after it nobody can. null — the lease is not the release's any more,
 * or a newer run took it over.
 */
export async function takeOverReleaseLease(
  db: Db,
  input: { releaseId: string; ttlMs: number },
): Promise<ReleaseLease | null> {
  const releaseId = id.parse(input.releaseId)
  const ttlMs = ttlSchema.parse(input.ttlMs)
  return leaseOf(
    await db.$queryRaw`
      WITH r AS MATERIALIZED (
        SELECT id, site_id, task_id, lease_epoch, status FROM site_releases
        WHERE id = ${releaseId}::uuid AND lease_epoch > 0
        FOR UPDATE
      ), held AS MATERIALIZED (
        SELECT l.site_id FROM site_leases l JOIN r ON r.site_id = l.site_id
        WHERE l.holder_task_id = r.task_id AND l.operation = 'deploy'::"LeaseOperation"
          AND l.epoch = r.lease_epoch AND NOT l.held_for_operator
          AND (l.inflight_release_id = r.id
            OR (l.inflight_release_id IS NULL AND r.status = 'approved'::"ReleaseStatus"))
          AND l.epoch < 2147483647
        FOR UPDATE OF l
      ), lease AS (
        UPDATE site_leases l SET epoch = l.epoch + 1, acquired_at = clock_timestamp(),
          expires_at = clock_timestamp() + ${ttlMs}::int * interval '1 millisecond',
          updated_at = clock_timestamp()
        FROM held WHERE l.site_id = held.site_id
        RETURNING l.site_id, l.epoch, l.expires_at
      )
      UPDATE site_releases s SET lease_epoch = lease.epoch, updated_at = clock_timestamp()
      FROM r, lease WHERE s.id = r.id AND lease.site_id = r.site_id
      RETURNING s.site_id, s.task_id, s.lease_epoch AS epoch, lease.expires_at`,
  )
}

/**
 * Names the lease an `approved` release has just acquired (`SiteLeaseStore.acquire`) in its row:
 * from now on only takeOverReleaseLease moves it. false — the release left `approved`, or a
 * newer epoch is already recorded.
 */
export async function recordReleaseLease(
  db: Db,
  input: { releaseId: string; epoch: number },
): Promise<boolean> {
  const releaseId = id.parse(input.releaseId)
  const epoch = epochSchema.parse(input.epoch)
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    UPDATE site_releases SET lease_epoch = ${epoch}, updated_at = clock_timestamp()
    WHERE id = ${releaseId}::uuid AND status = 'approved'::"ReleaseStatus"
      AND lease_epoch < ${epoch}
    RETURNING id`
  return rows.length === 1
}

const statusList = z.array(z.enum(releaseStatuses)).min(1)

/**
 * Whether the run that holds `epoch` still owns the release: the row is in one of `statuses`
 * under that epoch, and the lease row is its own — its task, `deploy`, the epoch, not held for
 * an operator — under its barrier (before the barrier, while `approved`). Called right before
 * every write outside PostgreSQL: a push, a tag, a secret.
 */
export async function ownsReleaseLease(
  db: Db,
  input: { releaseId: string; epoch: number; statuses: readonly ReleaseStatus[] },
): Promise<boolean> {
  const releaseId = id.parse(input.releaseId)
  const epoch = epochSchema.parse(input.epoch)
  const statuses = statusList.parse(input.statuses)
  const rows = z.array(z.object({ valid: z.boolean() })).parse(
    await db.$queryRaw`
      SELECT EXISTS(
        SELECT 1 FROM site_releases r JOIN site_leases l ON l.site_id = r.site_id
        WHERE r.id = ${releaseId}::uuid AND r.lease_epoch = ${epoch}
          AND r.status::text = ANY(${statuses}::text[])
          AND l.holder_task_id = r.task_id AND l.operation = 'deploy'::"LeaseOperation"
          AND l.epoch = ${epoch} AND NOT l.held_for_operator
          AND (l.inflight_release_id = r.id
            OR (l.inflight_release_id IS NULL AND r.status = 'approved'::"ReleaseStatus"))
      ) AS valid`,
  )
  return rows[0]?.valid === true
}

/**
 * Raises the barrier of the release over its site, under the lease of `epoch` while it is
 * still alive: from now on no turn, preview seed or other release takes the site until the
 * release frees it (freeReleaseLease) or an operator decides. false — the lease is not the
 * release's, it expired, or another barrier stands.
 */
export async function raiseReleaseBarrier(
  db: Db,
  input: { releaseId: string; epoch: number },
): Promise<boolean> {
  const releaseId = id.parse(input.releaseId)
  const epoch = epochSchema.parse(input.epoch)
  const rows = await db.$queryRaw<Array<{ site_id: string }>>`
    UPDATE site_leases l SET inflight_release_id = r.id, updated_at = clock_timestamp()
    FROM site_releases r
    WHERE r.id = ${releaseId}::uuid AND r.lease_epoch = ${epoch}
      AND l.site_id = r.site_id AND l.holder_task_id = r.task_id
      AND l.operation = 'deploy'::"LeaseOperation" AND l.epoch = ${epoch}
      AND NOT l.held_for_operator AND l.inflight_release_id IS NULL
      AND l.inflight_mcp_call_id IS NULL AND l.expires_at > clock_timestamp()
    RETURNING l.site_id`
  return rows.length === 1
}

/**
 * The end of a release for its site: the barrier and the lease of `epoch` go together, so the
 * next owner acquires at the next epoch. false — this run does not own the release any more.
 */
export async function freeReleaseLease(
  db: Db,
  input: { releaseId: string; epoch: number },
): Promise<boolean> {
  const releaseId = id.parse(input.releaseId)
  const epoch = epochSchema.parse(input.epoch)
  const rows = await db.$queryRaw<Array<{ site_id: string }>>`
    UPDATE site_leases l SET holder_task_id = NULL, operation = NULL, acquired_at = NULL,
      expires_at = NULL, held_for_operator = false, inflight_release_id = NULL,
      updated_at = clock_timestamp()
    FROM site_releases r
    WHERE r.id = ${releaseId}::uuid AND r.lease_epoch = ${epoch}
      AND l.site_id = r.site_id AND l.holder_task_id = r.task_id
      AND l.operation = 'deploy'::"LeaseOperation" AND l.epoch = ${epoch}
      AND (l.inflight_release_id = r.id OR l.inflight_release_id IS NULL)
      AND l.inflight_mcp_call_id IS NULL
    RETURNING l.site_id`
  return rows.length === 1
}

/**
 * Keeps the lease of a release with a barrier alive while its deploy job reports: never shorter
 * than it is. The barrier names the owner, so the API of a release needs no epoch.
 */
export async function renewReleaseLease(
  db: Db,
  input: { releaseId: string; ttlMs: number },
): Promise<boolean> {
  const releaseId = id.parse(input.releaseId)
  const ttlMs = ttlSchema.parse(input.ttlMs)
  const rows = await db.$queryRaw<Array<{ site_id: string }>>`
    UPDATE site_leases SET updated_at = clock_timestamp(),
      expires_at = GREATEST(expires_at, clock_timestamp() + ${ttlMs}::int * interval '1 millisecond')
    WHERE inflight_release_id = ${releaseId}::uuid AND NOT held_for_operator
    RETURNING site_id`
  return rows.length === 1
}

/**
 * An outcome nobody can prove (`unknown`, Р31): the lease and the barrier stay with the release
 * for the operator, marked held. true only for the call that marked it — the one that writes
 * the feed row of the outcome.
 */
export async function holdReleaseForOperator(
  db: Db,
  input: { releaseId: string },
): Promise<boolean> {
  const releaseId = id.parse(input.releaseId)
  const rows = await db.$queryRaw<Array<{ site_id: string }>>`
    UPDATE site_leases SET held_for_operator = true, updated_at = clock_timestamp()
    WHERE inflight_release_id = ${releaseId}::uuid AND NOT held_for_operator
    RETURNING site_id`
  return rows.length === 1
}

/**
 * `releases:resolve`: the operator decided an `unknown` release. The lease held for the operator
 * is handed back to the release, so the next run of `release.advance` takes it over and ends
 * the release as decided. false — the barrier is not this release's, or it is not held.
 */
export async function returnReleaseFromOperator(
  db: Db,
  input: { releaseId: string },
): Promise<boolean> {
  const releaseId = id.parse(input.releaseId)
  const rows = await db.$queryRaw<Array<{ site_id: string }>>`
    UPDATE site_leases l SET held_for_operator = false, updated_at = clock_timestamp()
    FROM site_releases r
    WHERE r.id = ${releaseId}::uuid AND l.inflight_release_id = r.id
      AND l.holder_task_id = r.task_id AND l.epoch = r.lease_epoch AND l.held_for_operator
    RETURNING l.site_id`
  return rows.length === 1
}
