import type { Prisma, PrismaClient } from '@repo/db'
import {
  effortOfModelClass,
  feedLimits,
  feedTaskHeadSchema,
  modelClassSchema,
  previewOrigin,
  readFeedRow,
  type ChatCommandAvailability,
  type FeedItem,
  type FeedTaskHead,
  type PreviewAddress,
  type PreviewStatus,
  type TaskStatus,
} from '@repo/domain'

import { accessibleTask, taskNotFound } from './access.ts'
import { feedBrowser, type FeedBrowser } from './browser.ts'
import { candidateCountsOf, dialogCommands, dialogFacts, type DialogFacts } from './dialog-facts.ts'
import { dialogRetry, movingRequest } from './dialog-state.ts'

type Tx = Prisma.TransactionClient

/** The preview of a dialog as its panel shows it. */
export interface FeedPreview {
  status: PreviewStatus
  unavailableReason: string | null
  /** `scheme://host[:port]` of the preview; null — previews are not set up in this process. */
  origin: string | null
  revision: number
  dirty: boolean
}

export interface FeedCandidate {
  id: string
  revision: number
  status: 'current' | 'stale'
  /** null — the facts of the row are unreadable. */
  counts: ReturnType<typeof candidateCountsOf>
  proposedVersion: string
  checks: { pending: number; passed: number; failed: number; stale: number }
}

export interface DialogFeed {
  task: FeedTaskHead
  /** The cloud browser of a task in the browser (docs/plan/57, Б12–Б18); null for any other. */
  browser: FeedBrowser | null
  preview: FeedPreview | null
  candidate: FeedCandidate | null
  release: DialogFacts['release']
  undo: DialogFacts['undo']
  commands: ChatCommandAvailability[]
  events: FeedItem[]
  /** The id of the last row read, or the `after` of the request. */
  cursor: string
  more: boolean
}

/**
 * `task.feed` (feed design, «Чтение по идентификатору»): the head of the dialog and the rows
 * after the cursor from one snapshot of the database — REPEATABLE READ, read only — so an
 * answer never holds a new status without its row. Beside the head: the preview, the candidate
 * the dialog waits with, its latest release and the verdict on each command (Р20, Р34) — or, for
 * a task in the browser, the session of its browser (docs/plan/57, Б12). Rows are
 * read with `readFeedRow` and never thrown away, except a stage the reader does not know and a
 * second row of the same stage of a turn.
 */
export async function readDialogFeed(
  db: PrismaClient,
  input: {
    userId: string
    taskId: string
    /** `task_events.id` of the last row the screen has; '0' before the first. */
    after: string
    address: PreviewAddress | null
  },
): Promise<DialogFeed> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      const task = await tx.task.findFirst({
        where: accessibleTask(input.userId, input.taskId),
        select: {
          id: true,
          workspaceId: true,
          siteId: true,
          title: true,
          mode: true,
          status: true,
          attempt: true,
          turnNo: true,
          waiting: true,
          needsRepository: true,
          needsBrowser: true,
          modelClass: true,
        },
      })
      if (task === null) throw taskNotFound()
      const facts = await dialogFacts(tx, task, input.userId)
      const head = await feedHead(tx, task)
      const browser = await feedBrowser(tx, task)
      const page = await feedPage(tx, task.id, input.after)
      return {
        task: head,
        browser,
        preview:
          facts.preview === null
            ? null
            : {
                status: facts.preview.status,
                unavailableReason: facts.preview.unavailableReason,
                origin:
                  input.address === null
                    ? null
                    : previewOrigin(facts.preview.hostname, input.address),
                revision: facts.preview.revision,
                dirty: facts.preview.dirty,
              },
        candidate:
          facts.candidate === null
            ? null
            : {
                id: facts.candidate.id,
                revision: facts.candidate.revision,
                status: facts.candidate.status,
                counts: candidateCountsOf(facts.candidate.facts),
                proposedVersion: facts.candidate.proposedVersion,
                checks: facts.candidate.checks,
              },
        release: facts.release,
        undo: facts.undo,
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
    siteId: string
    title: string | null
    mode: 'work' | 'chat'
    status: TaskStatus
    attempt: number
    turnNo: number
    waiting: 'agents' | 'site' | null
    needsRepository: boolean
    needsBrowser: boolean
    /** The database's class; one the domain does not know (`service`) reads as the default. */
    modelClass: string | null
  },
): Promise<FeedTaskHead> {
  const lease = await tx.siteLease.findUnique({
    where: { siteId: task.siteId },
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
    mode: task.mode,
    status: task.status,
    attempt: task.attempt,
    turnNo: task.turnNo,
    waiting: task.status === 'queued' ? task.waiting : null,
    held: lease !== null && lease.heldForOperator && lease.holderTaskId === task.id,
    // docs/plan/53, «Попробовать ещё (18.10)»: decided by `retryVerdict` alone.
    canRetry: (await dialogRetry(tx, task)).allowed,
    workingSince: request?.createdAt.toISOString() ?? null,
    runningSince: work?.createdAt.toISOString() ?? null,
    requirements: { repository: task.needsRepository, browser: task.needsBrowser },
    // A task older than the classes thinks at the level of `standard` (`createDialog`'s default).
    effort: effortOfModelClass(modelClassSchema.catch('standard').parse(task.modelClass)),
  })
}

/** Rows after the cursor, at most a page of them, in the order of their ids. */
async function feedPage(
  tx: Tx,
  taskId: string,
  after: string,
): Promise<{ events: FeedItem[]; cursor: string; more: boolean }> {
  const rows = await tx.taskEvent.findMany({
    where: { taskId, clientVisible: true, id: { gt: BigInt(after) } },
    orderBy: { id: 'asc' },
    take: feedLimits.page + 1,
    select: { id: true, type: true, payload: true, createdAt: true },
  })
  const more = rows.length > feedLimits.page
  const page = more ? rows.slice(0, feedLimits.page) : rows
  const steps = new Set<string>()
  const events: FeedItem[] = []
  for (const row of page) {
    const event = readFeedRow(row.type, row.payload)
    if (event.type === 'skipped') continue
    if (event.type === 'feed.step') {
      const key = `${event.turn}:${event.step}`
      if (steps.has(key)) continue
      steps.add(key)
    }
    events.push({ ...event, id: String(row.id), at: row.createdAt.toISOString() })
  }
  return { events, cursor: page.length > 0 ? String(page.at(-1)!.id) : after, more }
}

/** The head of one dialog with its site and alias, for `task.get`. */
export async function readDialogHead(
  db: PrismaClient,
  input: { userId: string; taskId: string },
): Promise<FeedTaskHead & { siteId: string; alias: string; createdAt: Date; updatedAt: Date }> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`
      const task = await tx.task.findFirst({
        where: accessibleTask(input.userId, input.taskId),
        select: {
          id: true,
          siteId: true,
          alias: true,
          title: true,
          mode: true,
          status: true,
          attempt: true,
          turnNo: true,
          waiting: true,
          needsRepository: true,
          needsBrowser: true,
          modelClass: true,
          createdAt: true,
          updatedAt: true,
        },
      })
      if (task === null) throw taskNotFound()
      const head = await feedHead(tx, task)
      return {
        ...head,
        siteId: task.siteId,
        alias: task.alias,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}
