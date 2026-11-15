import { Prisma, type PrismaClient } from '@repo/db'
import type { ScheduledRunTrigger, TaskStatus } from '@repo/domain'

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
  /** The chat goes on in Telegram too (docs/plan/80-telegram.md, 80.6): the agent answers there. */
  telegram: boolean
  /**
   * The chat is a run of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп43): «По расписанию ·
   * <name>» or «Запуск вручную · <name>», a link to the task; `id` null — the task was deleted,
   * the label stays without a link (Зп23).
   */
  schedule: DialogSchedule | null
}

/** The scheduled task a chat is a run of (Зп43). */
export interface DialogSchedule {
  id: string | null
  name: string
  trigger: ScheduledRunTrigger
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

/** `DialogListItem.answered` of the row `t`. Read by the runs of scheduled tasks too (Зп5). */
export const ANSWERED = Prisma.sql`(t.status = 'awaiting_user'
  AND COALESCE(${ENDING} IN ('feed.result', 'feed.rewind'), false))`

/** `DialogListItem.rewound` of the row `t`. */
const REWOUND = Prisma.sql`(t.status = 'awaiting_user' AND COALESCE(${ENDING} = 'feed.rewind', false))`

/** The newest of the rows of `t` that end a pass — a candidate too, which a pass after a failure may bring. */
const PASS_ENDING = (column: Prisma.Sql) => Prisma.sql`(SELECT ${column} FROM task_events e
    WHERE e.task_id = t.id
      AND e.type IN ('feed.result', 'feed.question', 'feed.failure', 'feed.candidate',
        'feed.rewind', 'feed.redo')
    ORDER BY e.id DESC LIMIT 1)`

/**
 * `DialogListItem.failed` of the row `t`: of the rows that end a pass — a candidate too, which a
 * pass after a failure may bring — the newest is a failure. Read by the runs of scheduled tasks.
 */
export const FAILED = Prisma.sql`(t.status IN ('awaiting_user', 'awaiting_approval')
  AND COALESCE(${PASS_ENDING(Prisma.sql`e.type`)} = 'feed.failure', false))`

/**
 * The open chat `t` stopped at a limit (docs/plan/82-scheduled-tasks.md, Зп5): the newest row that
 * ends a pass is the platform's question about credits (`feed.question` of the kind `ceiling`) or
 * a failure for the weekly limit (`usage_limit`). `credits`, `weekly_limit`, `limit` (another
 * ceiling or window), or null — it did not stop.
 */
export const STOPPED = Prisma.sql`(CASE WHEN t.status IN ('awaiting_user', 'awaiting_approval')
  THEN ${PASS_ENDING(Prisma.sql`CASE
    WHEN e.type = 'feed.question' AND e.payload->>'kind' = 'ceiling' THEN
      CASE WHEN e.payload->>'reason' IN ('credits', 'gift') THEN 'credits' ELSE 'limit' END
    WHEN e.type = 'feed.failure' AND e.payload->>'code' = 'usage_limit' THEN
      CASE WHEN e.payload->'window'->>'kind' = 'week' THEN 'weekly_limit' ELSE 'limit' END
    END`)} END)`

/**
 * The scheduled task the chat `t` is a run of (Зп43): its id while it is not deleted, its name —
 * of the task while it is there, else of the run —, and how the run started. null — not a run.
 */
const SCHEDULE = Prisma.sql`(SELECT json_build_object(
    'id', CASE WHEN st.deleted_at IS NULL THEN st.id END,
    'name', CASE WHEN st.deleted_at IS NULL THEN st.name ELSE r.name END,
    'trigger', r.trigger)
  FROM scheduled_runs r JOIN scheduled_tasks st ON st.id = r.scheduled_task_id
  WHERE r.task_id = t.id)`

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
      EXISTS (SELECT 1 FROM chat_sessions c WHERE c.id = t.chat_session_id AND c.channel = 'telegram') AS telegram,
      ${SCHEDULE} AS schedule,
      t.project_id, t.project_name
    FROM members m
    CROSS JOIN LATERAL (
      SELECT t.id, t.title, t.status, t.created_at, t.updated_at, t.pinned_at, t.archived_at,
        t.chat_session_id,
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
  telegram: boolean
  schedule: DialogSchedule | null
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
  telegram: row.telegram,
  schedule: row.schedule,
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
  EXISTS (SELECT 1 FROM chat_sessions c WHERE c.id = t.chat_session_id AND c.channel = 'telegram') AS telegram,
  ${SCHEDULE} AS schedule,
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
  input: { userId: string; query: string; archiveOnly?: boolean },
): Promise<DialogListItem[]> {
  const words = input.query.replace(/\s+/gu, ' ').trim()
  if (words === '') return []
  const pattern = likePattern(words)
  const rows = await db.$queryRaw<DialogRow[]>`
    SELECT ${ITEM}
    FROM tasks t LEFT JOIN sites s ON s.id = t.site_id
    WHERE ${OF_USER(input.userId)} AND ${SHOWN}
      ${input.archiveOnly ? Prisma.sql`AND t.archived_at IS NOT NULL` : Prisma.empty}
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
