import { Prisma, type PrismaClient } from '@repo/db'
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
   * like Claude Code). The client may write on, but is not asked to. A failure after the answer
   * (28.10.2026: the dialog stays open) asks the client again: «продолжи».
   */
  answered: boolean
  createdAt: Date
  updatedAt: Date
  /** null — a chat without a project (docs/plan/61-chats-first.md, §5.9). */
  project: { id: string; name: string } | null
}

export interface DialogPage {
  items: DialogListItem[]
  /** null — the last page. */
  nextCursor: string | null
}

/** One folder of «По проектам»: a project with chats, or (`project` null) the chats without one. */
export interface DialogFolder {
  project: { id: string; name: string } | null
  count: number
  /** A chat of it waits for the client: the folder says so while it is closed. */
  attention: boolean
}

/** A folder of the list: the id of a project, or `none` for the chats without one. */
type DialogFolderKey = string

/** A chat that is shown (К34): not deleted, of a project that is not deleted or of none. */
const SHOWN = Prisma.sql`t.deleted_at IS NULL AND (t.site_id IS NULL OR s.deleted_at IS NULL)`

/** `DialogListItem.answered` of the row `t`. */
const ANSWERED = Prisma.sql`(t.status = 'awaiting_user' AND COALESCE((
  SELECT e.type = 'feed.result' FROM task_events e
  WHERE e.task_id = t.id AND e.type IN ('feed.result', 'feed.question', 'feed.failure')
  ORDER BY e.id DESC LIMIT 1), false))`

/** The chat `t` waits for the client: «Ждёт вашего решения» of the list (`dialogGroups`). */
const WAITS_FOR_CLIENT = Prisma.sql`(t.status = 'awaiting_approval'
  OR (t.status = 'awaiting_user' AND NOT ${ANSWERED}))`

/**
 * One page of the chats of the workspaces of `userId`, the latest changed first. A page per
 * workspace, then the page of them all: `tasks_workspace_updated_idx` gives each in its order, and
 * the rest of a workspace is not read — `workspace_id IN (…)` would read every chat it has and sort
 * them for each page. `undo` and `answered` are asked of the rows of the page alone.
 */
export function dialogPageQuery(input: {
  userId: string
  /** The id of a project; `none` — the chats without one. */
  folder?: DialogFolderKey | undefined
  cursor?: string | undefined
}): Prisma.Sql {
  const { folder } = input
  let inFolder = Prisma.empty
  if (folder === 'none') inFolder = Prisma.sql`AND t.site_id IS NULL`
  else if (folder !== undefined) inFolder = Prisma.sql`AND t.site_id = ${folder}::uuid`
  const after = input.cursor === undefined ? null : DIALOG_CURSOR_PATTERN.exec(input.cursor)
  const afterCursor =
    after === null
      ? Prisma.empty
      : Prisma.sql`AND (t.updated_at, t.id) <
          (timestamptz 'epoch' + ${BigInt(after[1]!)}::bigint * interval '1 microsecond', ${after[2]!}::uuid)`
  return Prisma.sql`
    SELECT t.id, t.title, t.status::text AS status, t.mode::text AS mode, t.created_at, t.updated_at,
      (extract(epoch FROM t.updated_at) * 1000000)::bigint AS updated_us,
      (SELECT CASE WHEN bool_or(u.status = 'installed') THEN 'installed'
          WHEN bool_or(u.status NOT IN ('failed', 'rolled_back')) THEN 'running' END
        FROM site_releases u WHERE u.task_id = t.id AND u.kind = 'undo') AS undo,
      ${ANSWERED} AS answered,
      t.project_id, t.project_name
    FROM members m
    CROSS JOIN LATERAL (
      SELECT t.id, t.title, t.status, t.mode, t.created_at, t.updated_at,
        s.id AS project_id, s.name AS project_name
      FROM tasks t LEFT JOIN sites s ON s.id = t.site_id
      WHERE t.workspace_id = m.workspace_id AND ${SHOWN} ${inFolder} ${afterCursor}
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ${DIALOG_PAGE + 1}
    ) t
    WHERE m.user_id = ${input.userId}::uuid
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ${DIALOG_PAGE + 1}`
}

/**
 * The chats of the user, a page at a time: all of them, of one project (`folder` — its id; someone
 * else's or a deleted one answers NOT_FOUND) or those without a project (`none`). The cursor keeps
 * `updated_at` to the microsecond, as PostgreSQL stores it: a JavaScript date would lose the part a
 * later page is told by.
 */
export async function listDialogs(
  db: PrismaClient,
  input: { userId: string; folder?: DialogFolderKey | undefined; cursor?: string | undefined },
): Promise<DialogPage> {
  const { folder } = input
  if (folder !== undefined && folder !== 'none') {
    const site = await db.site.findFirst({
      where: accessibleSite(input.userId, folder),
      select: { id: true },
    })
    if (site === null) throw siteNotFound()
  }
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
      project_id: string | null
      project_name: string | null
    }>
  >(dialogPageQuery(input))
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
      project: projectOf(row),
    })),
    nextCursor: rows.length > DIALOG_PAGE && last ? `${last.updated_us}_${last.id}` : null,
  }
}

const projectOf = (row: { project_id: string | null; project_name: string | null }) =>
  row.project_id === null || row.project_name === null
    ? null
    : { id: row.project_id, name: row.project_name }

/**
 * «По проектам» (К23): every project with chats, the latest changed first, then the chats without
 * a project. Counted here over all the chats: a page of the list would give wrong numbers.
 */
export async function listDialogFolders(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: { userId: string },
): Promise<DialogFolder[]> {
  const rows = await db.$queryRaw<
    Array<{
      project_id: string | null
      project_name: string | null
      count: number
      attention: boolean
    }>
  >`
    SELECT s.id AS project_id, s.name AS project_name, count(*)::int AS count,
      bool_or(${WAITS_FOR_CLIENT}) AS attention
    FROM tasks t LEFT JOIN sites s ON s.id = t.site_id
    WHERE t.workspace_id IN (SELECT m.workspace_id FROM members m WHERE m.user_id = ${input.userId}::uuid)
      AND ${SHOWN}
    GROUP BY s.id
    ORDER BY s.id IS NULL, max(t.updated_at) DESC, s.id`
  return rows.map((row) => ({
    project: projectOf(row),
    count: row.count,
    attention: row.attention,
  }))
}
