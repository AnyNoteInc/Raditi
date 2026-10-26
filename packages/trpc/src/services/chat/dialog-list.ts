import type { PrismaClient } from '@repo/db'
import type { TaskMode, TaskStatus } from '@repo/domain'

import { accessibleSite, siteNotFound } from '../site-basics.ts'

/** Dialogs of one page of the list. */
export const DIALOG_PAGE = 50

/** The cursor of the list: the microseconds of `updated_at` of the last dialog and its id. */
export const DIALOG_CURSOR_PATTERN =
  /^(\d{1,17})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/

export interface DialogListItem {
  id: string
  title: string | null
  status: TaskStatus
  mode: TaskMode
  /**
   * «Отменить выпуск» of the dialog's release (docs/plan/53, «Отмена выпуска»): `running` — an undo
   * goes on, `installed` — the release was undone; null — neither. The status of the dialog stays
   * `done` either way.
   */
  undo: 'running' | 'installed' | null
  /**
   * The dialog waits for nothing: the agent answered and asked no question (`awaiting_user`
   * after a `feed.result`; owner's answer of 26.10.2026 — «ожидает ввода также не нужно», a chat
   * like Claude Code). The client may write on, but is not asked to.
   */
  answered: boolean
  createdAt: Date
  updatedAt: Date
}

export interface DialogPage {
  items: DialogListItem[]
  /** null — the last page. */
  nextCursor: string | null
}

/**
 * The dialogs of a site, the latest changed first (`tasks_site_updated_idx`), a page at a time.
 * The cursor keeps `updated_at` to the microsecond, as PostgreSQL stores it: a JavaScript date
 * would lose the part a later page is told by.
 */
export async function listDialogs(
  db: PrismaClient,
  input: { userId: string; siteId: string; cursor?: string | undefined },
): Promise<DialogPage> {
  const site = await db.site.findFirst({
    where: accessibleSite(input.userId, input.siteId),
    select: { id: true },
  })
  if (site === null) throw siteNotFound()
  const after = input.cursor === undefined ? null : DIALOG_CURSOR_PATTERN.exec(input.cursor)
  const afterMicros = after === null ? null : BigInt(after[1]!)
  const afterId = after === null ? null : after[2]!
  const rows = await db.$queryRaw<
    Array<{
      id: string
      title: string | null
      status: TaskStatus
      mode: TaskMode
      undo: 'running' | 'installed' | null
      answered: boolean
      created_at: Date
      updated_at: Date
      updated_us: bigint
    }>
  >`
    SELECT id, title, status::text AS status, mode::text AS mode, created_at, updated_at,
      (extract(epoch FROM updated_at) * 1000000)::bigint AS updated_us,
      (SELECT CASE WHEN bool_or(u.status = 'installed') THEN 'installed'
          WHEN bool_or(u.status NOT IN ('failed', 'rolled_back')) THEN 'running' END
        FROM site_releases u WHERE u.task_id = tasks.id AND u.kind = 'undo') AS undo,
      (tasks.status = 'awaiting_user' AND COALESCE((
        SELECT e.type = 'feed.result' FROM task_events e
        WHERE e.task_id = tasks.id AND e.type IN ('feed.result', 'feed.question')
        ORDER BY e.id DESC LIMIT 1), false)) AS answered
    FROM tasks
    WHERE site_id = ${site.id}::uuid AND deleted_at IS NULL
      AND (${afterMicros}::bigint IS NULL
        OR (updated_at, id) < (timestamptz 'epoch' + ${afterMicros}::bigint * interval '1 microsecond', ${afterId}::uuid))
    ORDER BY updated_at DESC, id DESC
    LIMIT ${DIALOG_PAGE + 1}`
  const page = rows.slice(0, DIALOG_PAGE)
  const last = page.at(-1)
  return {
    items: page.map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      mode: row.mode,
      undo: row.undo,
      answered: row.answered,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    nextCursor: rows.length > DIALOG_PAGE && last ? `${last.updated_us}_${last.id}` : null,
  }
}
