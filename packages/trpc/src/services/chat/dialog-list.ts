import { Prisma, projectOwnedBy, type PrismaClient } from '@repo/db'
import {
  NO_PROJECT_FOLDER,
  projectNotFound,
  type ChatProject,
  type PullRequestState,
  type RepoBranchState,
  type ScheduledRunTrigger,
  type TaskStatus,
} from '@repo/domain'

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
  /** «Закрепить» (docs/plan/75-chat-input-output.md, ВВ21): it stands at the head of the list. */
  pinned: boolean
  /** «В архив»: it is in «Архив», not in the list. */
  archived: boolean
  /** The chat goes on in Telegram too (docs/plan/80-telegram.md, 80.6): the agent answers there. */
  telegram: boolean
  /** The project the chat is in (docs/plan/84-projects.md, ПР2); null — none. */
  project: ChatProject | null
  /**
   * The chat is a run of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп43): «По расписанию ·
   * <name>» or «Запуск вручную · <name>», a link to the task; `id` null — the task was deleted,
   * the label stays without a link (Зп23).
   */
  schedule: DialogSchedule | null
  /**
   * The chat's branch in the repository of its project (docs/plan/84-projects.md, §4.8, ревью P9):
   * the hint of its row; null — the chat changed nothing in the repository its project has now.
   */
  repo: DialogRepo | null
}

/** What the row of a chat of a project says of its branch (§4.8). */
export interface DialogRepo {
  /** `project_repo_branches.state` (ПР13). */
  state: RepoBranchState
  /** The branch at the client has the chat's head (or nothing of it stands): nothing waits. */
  sent: boolean
  /** The newest merge request of the branch, as core last read it (ПР14); null — none. */
  request: { state: PullRequestState } | null
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

/** Which chats the list shows: the list itself, or «Архив» (ВВ21). */
export type DialogView = 'active' | 'archive'

/**
 * The chats of one folder of «По проектам» (owner's request of 19.11.2026, after docs/plan/61,
 * К23): a project of the user by its id, or `none` — the chats without a project.
 */
export const NO_PROJECT = NO_PROJECT_FOLDER
export type DialogFolderKey = string

/** One folder of «По проектам»: a project with chats, or (`project` null) the chats without one. */
export interface DialogFolder {
  project: ChatProject | null
  /** The project is in «Архив»: no new chat can start in it. */
  archived: boolean
  /** Its chats in the list, the pinned among them; not those in «Архив». */
  count: number
  /** A chat of it waits for the client: the folder says so while it is closed. */
  attention: boolean
}

/** The most pinned chats the head of the list shows, and the most a search finds. */
export const DIALOG_PINNED_LIMIT = 50
export const DIALOG_SEARCH_LIMIT = 50
/** The longest words a search of the chats takes. */
export const DIALOG_SEARCH_TEXT = 100

/**
 * A chat that is shown (К34): not deleted, and not of a project in the trash — its chats go there
 * with it (docs/plan/84-projects.md, ПР20).
 */
const SHOWN = Prisma.sql`t.deleted_at IS NULL AND (t.project_id IS NULL OR EXISTS (
  SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.deleted_at IS NULL))`

/** The project of the chat `t` that is shown, as two columns. */
const PROJECT = Prisma.sql`t.project_id,
  (SELECT p.name FROM projects p WHERE p.id = t.project_id) AS project_name`

/**
 * The newest row of `t` that says what its chat waits for, as the column `ending.type`, read once
 * per chat for `ANSWERED` and `REWOUND` (and only for a chat that waits for the client). A
 * `feed.rewind` before a `feed.redo` is as if it were not there: `/redo` took it back, and an older
 * one stands before a later turn. Every query that reads `ANSWERED` or `REWOUND` joins it after `t`.
 * `client_visible` (= `feed.*`, CHECK task_events_feed_visible_check) lets `task_events_feed_idx`
 * serve the read.
 */
export const ENDING_JOIN = Prisma.sql`LEFT JOIN LATERAL (SELECT e.type FROM task_events e
  WHERE t.status = 'awaiting_user' AND e.task_id = t.id AND e.client_visible
    AND e.type IN ('feed.result', 'feed.question', 'feed.failure', 'feed.rewind')
    AND NOT (e.type = 'feed.rewind' AND EXISTS (SELECT 1 FROM task_events r
      WHERE r.task_id = t.id AND r.client_visible AND r.type = 'feed.redo' AND r.id > e.id))
  ORDER BY e.id DESC LIMIT 1) ending ON true`

/**
 * `DialogListItem.answered` of the row `t`. Read by the runs of scheduled tasks too (Зп5); the
 * query joins `ENDING_JOIN`.
 */
export const ANSWERED = Prisma.sql`(t.status = 'awaiting_user'
  AND COALESCE(ending.type IN ('feed.result', 'feed.rewind'), false))`

/** `DialogListItem.rewound` of the row `t`; the query joins `ENDING_JOIN`. */
const REWOUND = Prisma.sql`(t.status = 'awaiting_user' AND COALESCE(ending.type = 'feed.rewind', false))`

/** The newest of the rows of `t` that end a pass — a candidate too, which a pass after a failure may bring. */
const PASS_ENDING = (column: Prisma.Sql) => Prisma.sql`(SELECT ${column} FROM task_events e
    WHERE e.task_id = t.id AND e.client_visible
      AND e.type IN ('feed.result', 'feed.question', 'feed.failure', 'feed.candidate',
        'feed.rewind', 'feed.redo')
    ORDER BY e.id DESC LIMIT 1)`

/**
 * `DialogListItem.failed` of the row `t`: of the rows that end a pass — a candidate too, which a
 * pass after a failure may bring — the newest is a failure. Read by the runs of scheduled tasks.
 */
export const FAILED = Prisma.sql`(t.status IN ('awaiting_user', 'awaiting_approval')
  AND COALESCE(${PASS_ENDING(Prisma.sql`e.type`)} = 'feed.failure', false))`

/** The chat `t` waits for the client: a question or a confirmation, not an answer or a failure. */
const WAITS_FOR_CLIENT = Prisma.sql`(NOT ${FAILED} AND (t.status = 'awaiting_approval'
  OR (t.status = 'awaiting_user' AND NOT ${ANSWERED})))`

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

/**
 * The branch of the chat `t` in the repository its project has now (§4.8): its state, whether its
 * head — the newest standing turn with one, as `chatBranchHead` reads it — was sent, and the newest
 * merge request of it. Lookups by key of the row alone: the primary key of the branch, the
 * repository of the project, `task_turns (task_id, turn_no)` and the merge requests of one
 * repository.
 */
const REPO = Prisma.sql`(SELECT json_build_object(
    'state', b.state,
    'sent', b.mirror_sha IS NOT DISTINCT FROM COALESCE((SELECT h.head_sha FROM task_turns h
      WHERE h.task_id = t.id AND h.status = 'completed' AND h.rejected_at IS NULL
        AND h.undone_at IS NULL AND h.head_sha IS NOT NULL
      ORDER BY h.turn_no DESC LIMIT 1), b.mirror_sha),
    'request', (SELECT json_build_object('state', r.state) FROM project_merge_requests r
      WHERE r.project_repository_id = b.project_repository_id AND r.source_branch = b.branch
      ORDER BY r.number DESC LIMIT 1))
  FROM project_repo_branches b
  JOIN project_repositories pr ON pr.id = b.project_repository_id AND pr.project_id = t.project_id
  WHERE b.task_id = t.id)`

/**
 * One page of the chats of the workspaces of `userId`, the latest changed first. A page per
 * workspace, then the page of them all: `tasks_workspace_updated_idx` gives each in its order, and
 * the rest of a workspace is not read — `workspace_id IN (…)` would read every chat it has and sort
 * them for each page. `undo`, `answered`, `rewound` and `failed` are asked of the rows of the page
 * alone.
 */
export function dialogPageQuery(input: {
  userId: string
  cursor?: string | undefined
  /** `active` (the default): the list without its pinned and archived chats; `archive` — «Архив». */
  view?: DialogView | undefined
  /** The chats of one project alone (ПР2), its owner checked by the caller; `none` — of none. */
  projectId?: DialogFolderKey | undefined
}): Prisma.Sql {
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
  // The chats of a project: `tasks_project_updated_idx` gives them in their order.
  if (input.projectId !== undefined && input.projectId !== NO_PROJECT)
    return Prisma.sql`
      SELECT ${ITEM}
      FROM tasks t ${ENDING_JOIN}
      WHERE t.project_id = ${input.projectId}::uuid AND ${SHOWN} ${inView} ${afterCursor}
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ${DIALOG_PAGE + 1}`
  return Prisma.sql`
    SELECT t.id, t.title, t.status::text AS status, t.created_at, t.updated_at,
      (extract(epoch FROM t.updated_at) * 1000000)::bigint AS updated_us,
      ${ANSWERED} AS answered,
      ${REWOUND} AS rewound,
      ${FAILED} AS failed,
      t.pinned_at IS NOT NULL AS pinned, t.archived_at IS NOT NULL AS archived,
      EXISTS (SELECT 1 FROM chat_sessions c WHERE c.id = t.chat_session_id AND c.channel = 'telegram') AS telegram,
      ${PROJECT},
      ${SCHEDULE} AS schedule,
      ${REPO} AS repo
    FROM members m
    CROSS JOIN LATERAL (
      SELECT t.id, t.title, t.status, t.created_at, t.updated_at, t.pinned_at, t.archived_at,
        t.chat_session_id, t.project_id
      FROM tasks t
      WHERE t.workspace_id = m.workspace_id AND ${SHOWN} ${inView} ${afterCursor}
        ${input.projectId === NO_PROJECT ? Prisma.sql`AND t.project_id IS NULL` : Prisma.empty}
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ${DIALOG_PAGE + 1}
    ) t
    ${ENDING_JOIN}
    WHERE m.user_id = ${input.userId}::uuid
    ORDER BY t.updated_at DESC, t.id DESC
    LIMIT ${DIALOG_PAGE + 1}`
}

/**
 * The chats of the user, a page at a time. The cursor keeps
 * `updated_at` to the microsecond, as PostgreSQL stores it: a JavaScript date would lose the part a
 * later page is told by.
 */
export async function listDialogs(
  db: PrismaClient,
  input: {
    userId: string
    cursor?: string | undefined
    view?: DialogView | undefined
    /**
     * The chats of one project of the user (ПР2), PROJECT_NOT_FOUND for any other; `none` — those
     * without a project.
     */
    projectId?: DialogFolderKey | undefined
  },
): Promise<DialogPage> {
  if (
    input.projectId !== undefined &&
    input.projectId !== NO_PROJECT &&
    (await projectOwnedBy(db, input.projectId, input.userId)) === null
  )
    throw projectNotFound()
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
  answered: boolean
  rewound: boolean
  failed: boolean
  pinned: boolean
  archived: boolean
  telegram: boolean
  project_id: string | null
  project_name: string | null
  schedule: DialogSchedule | null
  repo: DialogRepo | null
  created_at: Date
  updated_at: Date
  updated_us: bigint
}

const itemOf = (row: DialogRow): DialogListItem => ({
  id: row.id,
  title: row.title,
  status: row.status,
  answered: row.answered,
  rewound: row.rewound,
  failed: row.failed,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  pinned: row.pinned,
  archived: row.archived,
  telegram: row.telegram,
  project:
    row.project_id === null || row.project_name === null
      ? null
      : { id: row.project_id, name: row.project_name },
  schedule: row.schedule,
  repo: row.repo,
})

/** What every query of the list says of the chat `t`. */
const ITEM = Prisma.sql`t.id, t.title, t.status::text AS status, t.created_at, t.updated_at,
  (extract(epoch FROM t.updated_at) * 1000000)::bigint AS updated_us,
  ${ANSWERED} AS answered,
  ${REWOUND} AS rewound,
  ${FAILED} AS failed,
  t.pinned_at IS NOT NULL AS pinned, t.archived_at IS NOT NULL AS archived,
  EXISTS (SELECT 1 FROM chat_sessions c WHERE c.id = t.chat_session_id AND c.channel = 'telegram') AS telegram,
  ${PROJECT},
  ${SCHEDULE} AS schedule,
  ${REPO} AS repo`

/** The chats of the user's workspaces. */
const OF_USER = (userId: string) =>
  Prisma.sql`t.workspace_id IN (SELECT m.workspace_id FROM members m WHERE m.user_id = ${userId}::uuid)`

/** The pinned chats of the head of the list (ВВ21), the last pinned first; of a folder alone. */
export function pinnedQuery(input: { userId: string; projectId?: DialogFolderKey | undefined }) {
  const inFolder =
    input.projectId === undefined
      ? Prisma.empty
      : input.projectId === NO_PROJECT
        ? Prisma.sql`AND t.project_id IS NULL`
        : Prisma.sql`AND t.project_id = ${input.projectId}::uuid`
  return Prisma.sql`
    SELECT ${ITEM}
    FROM tasks t ${ENDING_JOIN}
    WHERE ${OF_USER(input.userId)} AND ${SHOWN}
      ${inFolder}
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
    FROM tasks t ${ENDING_JOIN}
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

/**
 * «По проектам» (owner's request of 19.11.2026, after docs/plan/61, К23): every project with chats
 * in the list, the latest changed first, then the chats without a project. Counted here over all
 * the chats: a page of the list would give wrong numbers. A project in the trash takes its chats
 * with it (ПР20), one in «Архив» keeps its folder while it has chats. The events of a chat are read
 * only for the chats that can wait for the client: the folders are read again with the list.
 * A project is named by its row alone, as in the list (`PROJECT`): the workspaces are personal,
 * so the project of a chat of the user is the user's — with members, check its author here too.
 */
export async function listDialogFolders(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: { userId: string },
): Promise<DialogFolder[]> {
  const rows = await db.$queryRaw<
    Array<{
      project_id: string | null
      project_name: string | null
      archived: boolean
      count: number
      attention: boolean
    }>
  >`
    SELECT p.id AS project_id, p.name AS project_name, (p.archived_at IS NOT NULL) AS archived,
      count(*)::int AS count,
      bool_or(CASE WHEN t.status IN ('awaiting_user', 'awaiting_approval')
        THEN ${WAITS_FOR_CLIENT} ELSE false END) AS attention
    FROM tasks t LEFT JOIN projects p ON p.id = t.project_id ${ENDING_JOIN}
    WHERE ${OF_USER(input.userId)} AND ${SHOWN} AND t.archived_at IS NULL
    GROUP BY p.id, p.name, p.archived_at
    ORDER BY p.id IS NULL, max(t.updated_at) DESC, p.id`
  return rows.map((row) => ({
    project:
      row.project_id === null || row.project_name === null
        ? null
        : { id: row.project_id, name: row.project_name },
    archived: row.project_id !== null && row.archived,
    count: row.count,
    attention: row.attention,
  }))
}
