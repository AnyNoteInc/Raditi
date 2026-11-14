import { Prisma, type PrismaClient } from '@repo/db'
import type { TaskStatus } from '@repo/domain'

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
   * (28.10.2026: the dialog stays open) asks the client again: «продолжи». `/undo` leaves it so too.
   */
  answered: boolean
  /** It is `/undo` that left it so: there is no answer to speak of (`taskRewoundLabel`). */
  rewound: boolean
  /**
   * The last pass of the open dialog failed (`feed.failure` is its newest ending, a kept candidate
   * included): the list says «Ошибка» and does not put it among those that wait for the client —
   * there is nothing to confirm (owner's request of 06.11.2026). The client may still write on.
   */
  failed: boolean
  createdAt: Date
  updatedAt: Date
  /** null — a chat without a project (docs/plan/61-chats-first.md, §5.9). */
  project: { id: string; name: string } | null
  /** «Закрепить» (docs/plan/75-chat-input-output.md, ВВ21): it stands at the head of the list. */
  pinned: boolean
  /** «В архив»: it is in «Архив», not in the list. */
  archived: boolean
}

export interface DialogPage {
  /**
   * The pinned chats, the last pinned first: on the first page of the list (no cursor, no
   * archive), and only there; the pages after it do not repeat them.
   */
  pinned: DialogListItem[]
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

/** Which chats the list shows: the list itself, or «Архив» (ВВ21). */
export type DialogView = 'active' | 'archive'

/** The most pinned chats the head of the list shows, and the most a search finds. */
export const DIALOG_PINNED_LIMIT = 50
export const DIALOG_SEARCH_LIMIT = 50
/** The longest words a search of the chats takes. */
export const DIALOG_SEARCH_TEXT = 100

/** A chat that is shown (К34): not deleted, of a project that is not deleted or of none. */
const SHOWN = Prisma.sql`t.deleted_at IS NULL AND (t.site_id IS NULL OR s.deleted_at IS NULL)`

/**
 * The newest row of `t` that says what its chat waits for. A `feed.rewind` before a `feed.redo` is
 * as if it were not there: `/redo` took it back, and an older one stands before a later turn.
 */
const ENDING = Prisma.sql`(SELECT e.type FROM task_events e
  WHERE e.task_id = t.id
    AND e.type IN ('feed.result', 'feed.question', 'feed.failure', 'feed.rewind')
    AND NOT (e.type = 'feed.rewind' AND EXISTS (SELECT 1 FROM task_events r
      WHERE r.task_id = t.id AND r.type = 'feed.redo' AND r.id > e.id))
  ORDER BY e.id DESC LIMIT 1)`

/** `DialogListItem.answered` of the row `t`. */
const ANSWERED = Prisma.sql`(t.status = 'awaiting_user'
  AND COALESCE(${ENDING} IN ('feed.result', 'feed.rewind'), false))`

/** `DialogListItem.rewound` of the row `t`. */
const REWOUND = Prisma.sql`(t.status = 'awaiting_user' AND COALESCE(${ENDING} = 'feed.rewind', false))`

/**
 * `DialogListItem.failed` of the row `t`: of the rows that end a pass — a candidate too, which a
 * pass after a failure may bring — the newest is a failure.
 */
const FAILED = Prisma.sql`(t.status IN ('awaiting_user', 'awaiting_approval')
  AND COALESCE((SELECT e.type FROM task_events e
    WHERE e.task_id = t.id
      AND e.type IN ('feed.result', 'feed.question', 'feed.failure', 'feed.candidate',
        'feed.rewind', 'feed.redo')
    ORDER BY e.id DESC LIMIT 1) = 'feed.failure', false))`

/** The chat `t` waits for the client: «Ждёт вашего решения» of the list (`dialogGroups`). */
const WAITS_FOR_CLIENT = Prisma.sql`(NOT ${FAILED} AND (t.status = 'awaiting_approval'
  OR (t.status = 'awaiting_user' AND NOT ${ANSWERED})))`

/**
 * One page of the chats of the workspaces of `userId`, the latest changed first. A page per
 * workspace, then the page of them all: `tasks_workspace_updated_idx` gives each in its order, and
 * the rest of a workspace is not read — `workspace_id IN (…)` would read every chat it has and sort
 * them for each page. `undo`, `answered`, `rewound` and `failed` are asked of the rows of the page
 * alone.
 */
export function dialogPageQuery(input: {
  userId: string
  /** The id of a project; `none` — the chats without one. */
  folder?: DialogFolderKey | undefined
  cursor?: string | undefined
  /** `active` (the default): the list without its pinned and archived chats; `archive` — «Архив». */
  view?: DialogView | undefined
}): Prisma.Sql {
  const { folder } = input
  let inFolder = Prisma.empty
  if (folder === 'none') inFolder = Prisma.sql`AND t.site_id IS NULL`
  else if (folder !== undefined) inFolder = Prisma.sql`AND t.site_id = ${folder}::uuid`
  const inView =
    input.view === 'archive'
      ? Prisma.sql`AND t.archived_at IS NOT NULL`
      : Prisma.sql`AND t.archived_at IS NULL AND t.pinned_at IS NULL`
  const after = input.cursor === undefined ? null : DIALOG_CURSOR_PATTERN.exec(input.cursor)
  const afterCursor =
    after === null
      ? Prisma.empty
      : Prisma.sql`AND (t.updated_at, t.id) <
          (timestamptz 'epoch' + ${BigInt(after[1]!)}::bigint * interval '1 microsecond', ${after[2]!}::uuid)`
  return Prisma.sql`
    SELECT t.id, t.title, t.status::text AS status, t.created_at, t.updated_at,
      (extract(epoch FROM t.updated_at) * 1000000)::bigint AS updated_us,
      (SELECT CASE WHEN bool_or(u.status = 'installed') THEN 'installed'
          WHEN bool_or(u.status NOT IN ('failed', 'rolled_back')) THEN 'running' END
        FROM site_releases u WHERE u.task_id = t.id AND u.kind = 'undo') AS undo,
      ${ANSWERED} AS answered,
      ${REWOUND} AS rewound,
      ${FAILED} AS failed,
      t.pinned_at IS NOT NULL AS pinned, t.archived_at IS NOT NULL AS archived,
      t.project_id, t.project_name
    FROM members m
    CROSS JOIN LATERAL (
      SELECT t.id, t.title, t.status, t.created_at, t.updated_at, t.pinned_at, t.archived_at,
        s.id AS project_id, s.name AS project_name
      FROM tasks t LEFT JOIN sites s ON s.id = t.site_id
      WHERE t.workspace_id = m.workspace_id AND ${SHOWN} ${inFolder} ${inView} ${afterCursor}
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
  input: {
    userId: string
    folder?: DialogFolderKey | undefined
    cursor?: string | undefined
    view?: DialogView | undefined
  },
): Promise<DialogPage> {
  const { folder } = input
  if (folder !== undefined && folder !== 'none') {
    const site = await db.site.findFirst({
      where: accessibleSite(input.userId, folder),
      select: { id: true },
    })
    if (site === null) throw siteNotFound()
  }
  const rows = await db.$queryRaw<DialogRow[]>(dialogPageQuery(input))
  const page = rows.slice(0, DIALOG_PAGE)
  const last = page.at(-1)
  const withPinned = input.cursor === undefined && input.view !== 'archive'
  return {
    pinned: withPinned ? (await db.$queryRaw<DialogRow[]>(pinnedQuery(input))).map(itemOf) : [],
    items: page.map(itemOf),
    nextCursor: rows.length > DIALOG_PAGE && last ? `${last.updated_us}_${last.id}` : null,
  }
}

/** A row of the queries of the list, as PostgreSQL gives it. */
interface DialogRow {
  id: string
  title: string | null
  status: TaskStatus
  undo: 'running' | 'installed' | null
  answered: boolean
  rewound: boolean
  failed: boolean
  pinned: boolean
  archived: boolean
  created_at: Date
  updated_at: Date
  updated_us: bigint
  project_id: string | null
  project_name: string | null
}

const itemOf = (row: DialogRow): DialogListItem => ({
  id: row.id,
  title: row.title,
  status: row.status,
  undo: row.undo,
  answered: row.answered,
  rewound: row.rewound,
  failed: row.failed,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  project: projectOf(row),
  pinned: row.pinned,
  archived: row.archived,
})

/** What every query of the list says of the chat `t` joined with its project `s`. */
const ITEM = Prisma.sql`t.id, t.title, t.status::text AS status, t.created_at, t.updated_at,
  (extract(epoch FROM t.updated_at) * 1000000)::bigint AS updated_us,
  (SELECT CASE WHEN bool_or(u.status = 'installed') THEN 'installed'
      WHEN bool_or(u.status NOT IN ('failed', 'rolled_back')) THEN 'running' END
    FROM site_releases u WHERE u.task_id = t.id AND u.kind = 'undo') AS undo,
  ${ANSWERED} AS answered,
  ${REWOUND} AS rewound,
  ${FAILED} AS failed,
  t.pinned_at IS NOT NULL AS pinned, t.archived_at IS NOT NULL AS archived,
  s.id AS project_id, s.name AS project_name`

/** The chats of the user's workspaces. */
const OF_USER = (userId: string) =>
  Prisma.sql`t.workspace_id IN (SELECT m.workspace_id FROM members m WHERE m.user_id = ${userId}::uuid)`

/** The pinned chats of the head of the list (ВВ21), of the folder too, the last pinned first. */
export function pinnedQuery(input: { userId: string; folder?: DialogFolderKey | undefined }) {
  const { folder } = input
  let inFolder = Prisma.empty
  if (folder === 'none') inFolder = Prisma.sql`AND t.site_id IS NULL`
  else if (folder !== undefined) inFolder = Prisma.sql`AND t.site_id = ${folder}::uuid`
  return Prisma.sql`
    SELECT ${ITEM}
    FROM tasks t LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${OF_USER(input.userId)} AND ${SHOWN} ${inFolder}
      AND t.pinned_at IS NOT NULL AND t.archived_at IS NULL
    ORDER BY t.pinned_at DESC, t.id DESC
    LIMIT ${DIALOG_PINNED_LIMIT}`
}

/** `%` and `_` of the client's words are letters, not patterns. */
export function likePattern(words: string): string {
  return `%${words.replace(/[\\%_]/g, (sign) => `\\${sign}`)}%`
}

/**
 * «Поиск по чатам» (ВВ21): the chats of the user — in «Архив» too — whose name or whose client's
 * words hold the words, the latest changed first, at most `DIALOG_SEARCH_LIMIT`. The words of the
 * agent are not searched: they are not the client's to look for.
 */
export async function searchDialogs(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: { userId: string; query: string },
): Promise<DialogListItem[]> {
  const words = input.query.replace(/\s+/gu, ' ').trim()
  if (words === '') return []
  const pattern = likePattern(words)
  const rows = await db.$queryRaw<DialogRow[]>`
    SELECT ${ITEM}
    FROM tasks t LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${OF_USER(input.userId)} AND ${SHOWN}
      AND (t.title ILIKE ${pattern}
        OR EXISTS (SELECT 1 FROM task_events e
          WHERE e.task_id = t.id AND e.client_visible AND e.type = 'feed.request'
            AND e.payload->>'text' ILIKE ${pattern}))
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ${DIALOG_SEARCH_LIMIT}`
  return rows.map(itemOf)
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
      AND ${SHOWN} AND t.archived_at IS NULL
    GROUP BY s.id
    ORDER BY s.id IS NULL, max(t.updated_at) DESC, s.id`
  return rows.map((row) => ({
    project: projectOf(row),
    count: row.count,
    attention: row.attention,
  }))
}
