import { Prisma, type PrismaClient } from '@repo/db'
import type { TaskStatus } from '@repo/domain'

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

/** The most pinned chats the head of the list shows, and the most a search finds. */
export const DIALOG_PINNED_LIMIT = 50
export const DIALOG_SEARCH_LIMIT = 50
/** The longest words a search of the chats takes. */
export const DIALOG_SEARCH_TEXT = 100

/** A chat that is shown (К34): not deleted. */
const SHOWN = Prisma.sql`t.deleted_at IS NULL`

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
  return Prisma.sql`
    SELECT t.id, t.title, t.status::text AS status, t.created_at, t.updated_at,
      (extract(epoch FROM t.updated_at) * 1000000)::bigint AS updated_us,
      ${ANSWERED} AS answered,
      ${REWOUND} AS rewound,
      ${FAILED} AS failed,
      t.pinned_at IS NOT NULL AS pinned, t.archived_at IS NOT NULL AS archived,
      EXISTS (SELECT 1 FROM chat_sessions c WHERE c.id = t.chat_session_id AND c.channel = 'telegram') AS telegram
    FROM members m
    CROSS JOIN LATERAL (
      SELECT t.id, t.title, t.status, t.created_at, t.updated_at, t.pinned_at, t.archived_at,
        t.chat_session_id
      FROM tasks t
      WHERE t.workspace_id = m.workspace_id AND ${SHOWN} ${inView} ${afterCursor}
      ORDER BY t.updated_at DESC, t.id DESC
      LIMIT ${DIALOG_PAGE + 1}
    ) t
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
  },
): Promise<DialogPage> {
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
})

/** What every query of the list says of the chat `t`. */
const ITEM = Prisma.sql`t.id, t.title, t.status::text AS status, t.created_at, t.updated_at,
  (extract(epoch FROM t.updated_at) * 1000000)::bigint AS updated_us,
  ${ANSWERED} AS answered,
  ${REWOUND} AS rewound,
  ${FAILED} AS failed,
  t.pinned_at IS NOT NULL AS pinned, t.archived_at IS NOT NULL AS archived,
  EXISTS (SELECT 1 FROM chat_sessions c WHERE c.id = t.chat_session_id AND c.channel = 'telegram') AS telegram`

/** The chats of the user's workspaces. */
const OF_USER = (userId: string) =>
  Prisma.sql`t.workspace_id IN (SELECT m.workspace_id FROM members m WHERE m.user_id = ${userId}::uuid)`

/** The pinned chats of the head of the list (ВВ21), the last pinned first. */
export function pinnedQuery(input: { userId: string }) {
  return Prisma.sql`
    SELECT ${ITEM}
    FROM tasks t
    WHERE ${OF_USER(input.userId)} AND ${SHOWN}
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
    FROM tasks t
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
