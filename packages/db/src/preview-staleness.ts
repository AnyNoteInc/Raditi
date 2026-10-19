import type { Prisma } from './generated/prisma/client.ts'

/**
 * Candidates that a later release left behind (docs/plan/53-chat-preview-release.md, Р15): the
 * seed of their dialog's preview was copied before the release the site holds now
 * (`preview_environments.seed_release_id` differs from `sites.installed_release_id`), so their
 * base is not what production is. A `current` candidate of such a dialog becomes `stale` — its
 * dialog needs «Обновить» before `/release`. Only a candidate recorded before that release
 * installed, on another commit than the installed one: «Обновить» records a candidate on the new
 * `main` at once, while the preview copies its new seed for minutes — that candidate is never
 * marked, or the dialog could not be released after the very step that brings it up to date.
 * The one helper of the preview manager (R5c) and of a release that has just installed (R8b):
 * called with the site, or for every site without it. Returns the ids of the candidates it marked.
 */
export async function markStaleCandidates(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { siteId?: string } = {},
): Promise<string[]> {
  const siteId = input.siteId ?? null
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE task_candidates c SET status = 'stale'
    FROM preview_environments p
    JOIN sites s ON s.id = p.site_id
    WHERE c.task_id = p.task_id
      AND c.status = 'current'
      AND p.seed_object_key IS NOT NULL
      AND p.seed_release_id IS DISTINCT FROM s.installed_release_id
      AND c.created_at < s.installed_at
      AND c.base_sha IS DISTINCT FROM s.installed_sha
      AND (${siteId}::uuid IS NULL OR p.site_id = ${siteId}::uuid)
    RETURNING c.id`
  return rows.map((row) => row.id)
}
