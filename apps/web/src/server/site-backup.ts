import 'server-only'

import { Readable } from 'node:stream'

// The copy of the import's files of a site, for «Скачать» in «База и бэкап» (owner's request of
// 26.10.2026): a member of the site's workspace gets the tar.gz from raditi-backups through the
// server. Neither the bucket nor the key reaches the browser, and no presigned URL is made: web
// signs none for itself (spec §14), and the download keeps the session check of the cabinet.

export interface SiteBackupDependencies {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>
  /** Whether the user of these headers accepted the current required documents (152-FZ). */
  hasRequiredConsents: (headers: Headers) => Promise<boolean>
  /** readSiteBackupDownload of @repo/trpc with the database and the store bound. */
  read: (input: {
    userId: string
    siteId: string
    backupId: string
  }) => Promise<{ body: AsyncIterable<Uint8Array>; bytes: number; fileName: string } | null>
  /** For the server log only: the cause never reaches the client. */
  onFailure?: (operation: string, error: unknown) => void
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BACKUP = /^(initial|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i

const answer = (status: number, message: string) =>
  Response.json({ message }, { status, headers: { 'cache-control': 'no-store' } })

export async function getSiteBackup(
  request: Request,
  params: { projectId: string; backupId: string },
  deps: SiteBackupDependencies,
): Promise<Response> {
  try {
    const session = await deps.getSession(request.headers)
    if (!session) return answer(401, 'Войдите в аккаунт, чтобы скачать копию.')
    if (!(await deps.hasRequiredConsents(request.headers)))
      return answer(428, 'Примите обновлённые документы, чтобы продолжить')
    const notFound = () => answer(404, 'Копия не найдена.')
    if (!UUID.test(params.projectId) || !BACKUP.test(params.backupId)) return notFound()
    const backup = await deps.read({
      userId: session.user.id,
      siteId: params.projectId.toLowerCase(),
      backupId: params.backupId.toLowerCase(),
    })
    // Someone else's site, a copy not made yet and one that is gone answer the same.
    if (!backup) return notFound()
    return new Response(Readable.toWeb(Readable.from(backup.body)) as ReadableStream, {
      headers: {
        'content-type': 'application/gzip',
        'content-length': String(backup.bytes),
        'content-disposition': `attachment; filename="${backup.fileName}"`,
        'cache-control': 'private, no-store',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
      },
    })
  } catch (error) {
    deps.onFailure?.('site backup download failed', error)
    return answer(503, 'Не удалось скачать копию. Попробуйте ещё раз немного позже.')
  }
}
