import { Prisma, type PrismaClient } from '@repo/db'
import {
  effortOfModelClass,
  FEED_CURSOR_OPEN_TRANSACTIONS,
  feedCursorParts,
  feedFileName,
  feedLimits,
  feedMarkdown,
  feedTaskHeadSchema,
  modelClassSchema,
  readFeedRow,
  type ChatCommandAvailability,
  type FeedItem,
  type FeedTaskHead,
  type ScheduledRunTrigger,
  type TaskStatus,
} from '@repo/domain'

import { accessibleTask, taskNotFound } from './access.ts'
import { feedBrowser, type FeedBrowser } from './browser.ts'
import { dialogCommands, dialogFacts } from './dialog-facts.ts'
import type { DialogSchedule } from './dialog-list.ts'
import { movingRequest, visible } from './dialog-state.ts'

type Tx = Prisma.TransactionClient

/** A long chat is many pages of rows: the snapshot stays open while they are read. */
const EXPORT_TIMEOUT_MS = 30_000

export interface DialogFeed {
  task: FeedTaskHead
  /** The cloud browser of a task in the browser (docs/plan/57, Б12–Б18); null for any other. */
  browser: FeedBrowser | null
  commands: ChatCommandAvailability[]
  events: FeedItem[]
  /**
   * The id of the last row read, or that of the `after` of the request, and what the snapshot of
   * the read could not see (`feedReadCursorSchema`); `0` — read again from the first row.
   */
  cursor: string
  more: boolean
}

/**
 * `task.feed` (feed design, «Чтение по идентификатору»): the head of the dialog and the rows
 * after the cursor from one snapshot of the database — REPEATABLE READ, read only — so an
 * answer never holds a new status without its row. Beside the head: the verdict on each command
 * (Р34) and the session of the chat's browser (docs/plan/57, Б12). Rows are
 * read with `readFeedRow` and never thrown away, except a stage the reader does not know and a
 * second row of the same stage of a turn.
 */
export async function readDialogFeed(
  db: PrismaClient,
  input: {
    userId: string
    taskId: string
    /** The cursor of the last answer the screen has (`feedReadCursorSchema`); '0' before the first. */
    after: string
  },
): Promise<DialogFeed> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      // With what the facts would read again: the reader's role.
      const row = await tx.task.findFirst({
        where: accessibleTask(input.userId, input.taskId),
        select: {
          id: true,
          workspaceId: true,
          title: true,
          status: true,
          attempt: true,
          turnNo: true,
          waiting: true,
          needsBrowser: true,
          modelClass: true,
          projectId: true,
          workspace: {
            select: { members: { where: { userId: input.userId }, select: { role: true } } },
          },
        },
      })
      if (row === null) throw taskNotFound()
      const { workspace, ...task } = row
      const facts = await dialogFacts(
        tx,
        { ...task, role: workspace.members[0]?.role ?? null },
        input.userId,
      )
      const head = await feedHead(tx, task)
      const browser = await feedBrowser(tx, task)
      const page = await feedPage(tx, task.id, input.after)
      return {
        task: head,
        browser,
        commands: dialogCommands(facts),
        ...page,
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

/** The head of a dialog (`feedTaskHeadSchema`), read in the snapshot of its rows. */
export async function feedHead(
  tx: Tx,
  task: {
    id: string
    title: string | null
    status: TaskStatus
    attempt: number
    turnNo: number
    waiting: 'agents' | 'site' | null
    needsBrowser: boolean
    /** The database's class; one the domain does not know (`service`) reads as the default. */
    modelClass: string | null
    /** The project of the chat (docs/plan/84-projects.md, ПР2). */
    projectId: string | null
  },
): Promise<FeedTaskHead> {
  const project =
    task.projectId === null
      ? null
      : await tx.project.findFirst({
          where: { id: task.projectId, deletedAt: null },
          select: { id: true, name: true },
        })
  // The chat's own lease: its turns hold it.
  const leases = await tx.siteLease.findMany({
    where: { siteId: task.id },
    select: { heldForOperator: true, holderTaskId: true },
  })
  // The work of the agent began with the last words or «Продолжить»; a press of a command
  // during it (`/cancel` while it stops) starts no clock of its own.
  const request = await tx.taskEvent.findFirst({
    where: { taskId: task.id, ...movingRequest },
    orderBy: { id: 'desc' },
    select: { createdAt: true },
  })
  const work =
    task.turnNo < 1
      ? null
      : await tx.taskEvent.findFirst({
          where: {
            taskId: task.id,
            ...visible,
            type: 'feed.step',
            AND: [
              { payload: { path: ['turn'], equals: task.turnNo } },
              { payload: { path: ['step'], equals: 'work' } },
            ],
          },
          orderBy: { id: 'asc' },
          select: { createdAt: true },
        })
  return feedTaskHeadSchema.parse({
    id: task.id,
    title: task.title,
    status: task.status,
    attempt: task.attempt,
    turnNo: task.turnNo,
    waiting: task.status === 'queued' ? task.waiting : null,
    held: leases.some((lease) => lease.heldForOperator && lease.holderTaskId === task.id),
    // «Попробовать ещё» kept a candidate; a chat has none (docs/plan/83-remove-projects.md).
    canRetry: false,
    workingSince: request?.createdAt.toISOString() ?? null,
    runningSince: work?.createdAt.toISOString() ?? null,
    requirements: { repository: false, browser: task.needsBrowser },
    // A task older than the classes thinks at the level of `standard` (`createDialog`'s default).
    effort: effortOfModelClass(modelClassSchema.catch('standard').parse(task.modelClass)),
    project,
  })
}

/**
 * What a snapshot could not see, for the next read (`feedReadCursorSchema`): the first transaction
 * id not given out yet and the open ones; past `FEED_CURSOR_OPEN_TRANSACTIONS` open ones, their
 * oldest as the bound and none named. One expression of the statement that reads the rows.
 */
const unseenOfSnapshot = Prisma.sql`
  SELECT CASE WHEN coalesce(cardinality(x.open), 0) > ${FEED_CURSOR_OPEN_TRANSACTIONS}
    THEN pg_snapshot_xmin(c)::text
    ELSE pg_snapshot_xmax(c)::text
      || CASE WHEN coalesce(cardinality(x.open), 0) > 0
        THEN '.' || array_to_string(x.open, '_') ELSE '' END
    END AS unseen
  FROM pg_current_snapshot() c,
    LATERAL (SELECT array_agg(i::text ORDER BY i) AS open FROM pg_snapshot_xip(c) i) x`

interface ReadRow {
  unseen: string
  id: bigint | null
  type: string | null
  payload: Prisma.JsonValue
  created_at: Date | null
  late: boolean | null
}

/**
 * Rows after the cursor, at most a page of them, in the order of their ids, and before them the
 * rows of the transactions the last read could not see, below its cursor: exactly those, never a
 * row it gave. The next cursor names what this snapshot could not see, whether or not the page
 * reaches the end. More of the late rows than a page — one transaction wrote that many, or too many
 * were open to name — and the reader starts over from the first row (cursor `0`).
 */
async function feedPage(
  tx: Tx,
  taskId: string,
  after: string,
): Promise<{ events: FeedItem[]; cursor: string; more: boolean }> {
  const { id, unseen } = feedCursorParts(after)
  const late =
    unseen === null
      ? Prisma.empty
      : Prisma.sql`
      UNION ALL
      (SELECT e.id, e.type, e.payload, e.created_at, true AS late FROM task_events e
       WHERE e.task_id = ${taskId}::uuid AND e.client_visible AND e.id <= ${BigInt(id)}
         AND (e.xact >= ${unseen.bound}::xid8 OR e.xact = ANY(${unseen.open}::text[]::xid8[]))
       ORDER BY e.id LIMIT ${feedLimits.page + 1})`
  // One statement: what this snapshot cannot see, the rows after the cursor and the late ones.
  const read = await tx.$queryRaw<ReadRow[]>`
    SELECT s.unseen, p.id, p.type, p.payload, p.created_at, p.late
    FROM (${unseenOfSnapshot}) s
    LEFT JOIN LATERAL (
      (SELECT e.id, e.type, e.payload, e.created_at, false AS late FROM task_events e
       WHERE e.task_id = ${taskId}::uuid AND e.client_visible AND e.id > ${BigInt(id)}
       ORDER BY e.id LIMIT ${feedLimits.page + 1})
      ${late}
    ) p ON true
    ORDER BY p.id`
  const now = read[0]?.unseen ?? '0'
  const rows = read.filter((row) => row.id !== null)
  const lateRows = rows.filter((row) => row.late === true)
  const fresh = rows.filter((row) => row.late !== true)
  if (lateRows.length > feedLimits.page)
    return { events: feedRows(fresh.slice(0, feedLimits.page)), cursor: '0', more: true }
  const more = fresh.length > feedLimits.page
  const page = more ? fresh.slice(0, feedLimits.page) : fresh
  const last = page.at(-1)?.id
  return {
    events: feedRows([...lateRows, ...page]),
    cursor: `${last == null ? id : String(last)}.${now}`,
    more,
  }
}

/** Rows as the feed gives them: read with `readFeedRow`, one row per stage of a turn. */
function feedRows(rows: readonly ReadRow[]): FeedItem[] {
  const steps = new Set<string>()
  const events: FeedItem[] = []
  for (const row of rows) {
    if (row.id === null || row.type === null || row.created_at === null) continue
    const event = readFeedRow(row.type, row.payload)
    if (event.type === 'skipped') continue
    if (event.type === 'feed.step') {
      const key = `${event.turn}:${event.step}`
      if (steps.has(key)) continue
      steps.add(key)
    }
    events.push({ ...event, id: String(row.id), at: row.created_at.toISOString() })
  }
  return events
}

/**
 * `task.export`: every row of a chat from one snapshot, as the screen would read them, written out
 * as a Markdown file.
 */
export async function readDialogExport(
  db: PrismaClient,
  input: { userId: string; taskId: string },
): Promise<{ fileName: string; markdown: string }> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      const task = await tx.task.findFirst({
        where: accessibleTask(input.userId, input.taskId),
        select: { id: true, title: true },
      })
      if (task === null) throw taskNotFound()
      // One snapshot: what it cannot see it never sees, so the pages go by id alone.
      const rows: FeedItem[] = []
      let cursor = '0'
      for (;;) {
        const page = await feedPage(tx, task.id, cursor)
        rows.push(...page.events)
        if (!page.more) break
        cursor = feedCursorParts(page.cursor).id
      }
      return {
        fileName: feedFileName(task.title),
        markdown: feedMarkdown({ title: task.title, rows, withSite: false }),
      }
    },
    { isolationLevel: 'RepeatableRead', timeout: EXPORT_TIMEOUT_MS },
  )
}

/** The head of one chat, for `task.get`. */
export async function readDialogHead(
  db: PrismaClient,
  input: { userId: string; taskId: string },
): Promise<
  FeedTaskHead & {
    createdAt: Date
    updatedAt: Date
    /** The scheduled task the chat is a run of (docs/plan/82-scheduled-tasks.md, Зп43). */
    schedule: DialogSchedule | null
  }
> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      const task = await tx.task.findFirst({
        where: accessibleTask(input.userId, input.taskId),
        select: {
          id: true,
          title: true,
          status: true,
          attempt: true,
          turnNo: true,
          waiting: true,
          needsBrowser: true,
          modelClass: true,
          projectId: true,
          createdAt: true,
          updatedAt: true,
        },
      })
      if (task === null) throw taskNotFound()
      const head = await feedHead(tx, task)
      const run = await tx.scheduledRun.findUnique({
        where: { taskId: task.id },
        select: {
          trigger: true,
          name: true,
          scheduledTask: { select: { id: true, name: true, deletedAt: true } },
        },
      })
      return {
        ...head,
        // The label «По расписанию · <name>»: a link while the task is there (Зп23, Зп43).
        schedule:
          run === null
            ? null
            : run.scheduledTask.deletedAt === null
              ? {
                  id: run.scheduledTask.id,
                  name: run.scheduledTask.name,
                  trigger: run.trigger as ScheduledRunTrigger,
                }
              : { id: null, name: run.name, trigger: run.trigger as ScheduledRunTrigger },
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}
