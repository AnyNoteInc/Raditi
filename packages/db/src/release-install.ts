import { z } from 'zod'

import type { Prisma } from './generated/prisma/client.ts'

// What an installed release changes for its site (docs/plan/53-chat-preview-release.md, Р15,
// Р26, Р27): the installed version, the candidate it came from, and every other dialog of the
// site whose candidate now stands on an older `main`.

type Tx = Pick<Prisma.TransactionClient, '$queryRaw'>

const id = z.uuid()

/**
 * The current candidates of the other dialogs of a site become `stale` (Р15): they stand on the
 * tree the site had before a release that ended later, so they need «Обновить» before their
 * own release. The dialog `exceptTaskId` — the one whose release it was — is left alone.
 * Returns how many were marked. Shared by the end of a release and the previews of the site.
 */
export async function markSiteCandidatesStale(
  tx: Tx,
  input: { siteId: string; exceptTaskId: string | null },
): Promise<number> {
  const siteId = id.parse(input.siteId)
  const except = input.exceptTaskId === null ? null : id.parse(input.exceptTaskId)
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE task_candidates c SET status = 'stale'
    FROM tasks t
    WHERE c.task_id = t.id AND t.site_id = ${siteId}::uuid AND c.status = 'current'
      AND (${except}::uuid IS NULL OR t.id <> ${except}::uuid)
    RETURNING c.id`
  return rows.length
}

export interface InstalledRelease {
  siteId: string
  taskId: string
  /** null — an undo (docs/plan/53, «Отмена выпуска»): it has no candidate. */
  candidateId: string | null
  /** The current candidates of other dialogs of the site made stale by it. */
  staleCandidates: number
}

/**
 * The first transaction of an installed release (Р26, R8b): the site records what its hosting
 * holds now — the version, the release commit, the moment and the release — the candidate of
 * the release is `released`, and the candidates of the other dialogs of the site are `stale`.
 * An undo of a release is installed the same way; it has no candidate of its own.
 * Only for a release that is `installed` with its commit, and once: a site that already names
 * this release is not written again (null). The barrier and the lease go in the same
 * transaction (freeReleaseLease); the dialog moves to `done` in a second one, with the charge.
 */
export async function installRelease(
  tx: Tx,
  input: { releaseId: string },
): Promise<InstalledRelease | null> {
  const releaseId = id.parse(input.releaseId)
  const rows = z.array(z.object({ site_id: id, task_id: id, candidate_id: id.nullable() })).parse(
    await tx.$queryRaw`
        UPDATE sites s SET installed_version = r.version, installed_sha = r.approved_sha,
          installed_at = clock_timestamp(), installed_release_id = r.id,
          updated_at = clock_timestamp()
        FROM site_releases r
        WHERE r.id = ${releaseId}::uuid AND s.id = r.site_id
          AND r.status = 'installed'::"ReleaseStatus" AND r.approved_sha IS NOT NULL
          AND s.installed_release_id IS DISTINCT FROM r.id
        RETURNING r.site_id, r.task_id, r.candidate_id`,
  )
  const row = rows[0]
  if (!row) return null
  if (row.candidate_id !== null)
    await tx.$queryRaw`
      UPDATE task_candidates SET status = 'released'
      WHERE id = ${row.candidate_id}::uuid AND status = 'current'
      RETURNING id`
  const staleCandidates = await markSiteCandidatesStale(tx, {
    siteId: row.site_id,
    exceptTaskId: row.task_id,
  })
  return {
    siteId: row.site_id,
    taskId: row.task_id,
    candidateId: row.candidate_id,
    staleCandidates,
  }
}
