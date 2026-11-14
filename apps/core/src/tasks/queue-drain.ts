import { Logger } from '@nestjs/common'
import { extendTaskHolds, placeCreditHold } from '@repo/billing'
import type { Prisma } from '@repo/db'
import { enqueueAgentTurn, insertFeedEvent, type PrismaClient } from '@repo/db'
import {
  isDomainError,
  readFeedRow,
  taskHoldExpiry,
  type FeedRequestPayload,
  type QueueDrainJob,
  type TaskStatus,
} from '@repo/domain'

// The queue of a chat after its pass ended (docs/plan/75-chat-input-output.md, ВВ1–ВВ5). The
// client wrote while the agent worked; the words waited in `task_queued_messages`. When the pass
// ended so that the dialog waits for the client — the agent answered, asked, brought changes, or
// the client pressed «Отправить сейчас» — the words become `feed.request` rows of the kind `queued`
// and the next pass starts with a reserve of its own, as `task.message` would start it. After a
// failure, a question of the platform about credits and the weekly limit they wait for the client
// (ВВ3): a failure must not go round in a circle. A reserve the account cannot give keeps them too,
// and the client sends them by hand, to hear why.

export type DrainAnswer = 'moved' | 'skipped' | 'refused'

export interface QueueDrainDependencies {
  db: PrismaClient
  logger?: { log(message: string): void; warn(message: string): void }
  now?: () => Date
}

/** The pass endings after which the queue goes by itself (ВВ2). */
const LETTING = ['feed.result', 'feed.question', 'feed.candidate'] as const

/** The rows that end a pass, the newest of which says whether the queue may go. */
const ENDINGS = [...LETTING, 'feed.failure', 'feed.cancelled'] as const

type Tx = Prisma.TransactionClient

interface LockedTask {
  status: TaskStatus
  attempt: number
  workspaceId: string
  billable: boolean
}

export class QueueDrain {
  readonly #logger: { log(message: string): void; warn(message: string): void }
  readonly #now: () => Date

  constructor(private readonly deps: QueueDrainDependencies) {
    this.#logger = deps.logger ?? new Logger('QueueDrain')
    this.#now = deps.now ?? (() => new Date())
  }

  async run(job: QueueDrainJob): Promise<DrainAnswer> {
    const now = this.#now()
    try {
      const answer = await this.deps.db.$transaction((tx) => this.#drain(tx, job.taskId, now), {
        isolationLevel: 'ReadCommitted',
        timeout: 30_000,
      })
      this.#logger.log(`queue_drain task=${job.taskId} answer=${answer}`)
      return answer
    } catch (error) {
      // The account gives no reserve now: the words stay queued, the client sends them by hand.
      if (isDomainError(error) && error.code.startsWith('BILLING_')) {
        this.#logger.warn(`queue_drain_refused task=${job.taskId} code=${error.code}`)
        return 'refused'
      }
      throw error
    }
  }

  async #drain(tx: Tx, taskId: string, now: Date): Promise<DrainAnswer> {
    const locked = await tx.$queryRaw<LockedTask[]>`
      SELECT status::text AS status, attempt, workspace_id AS "workspaceId", billable
      FROM tasks WHERE id = ${taskId}::uuid AND deleted_at IS NULL FOR UPDATE`
    const task = locked[0]
    if (!task || (task.status !== 'awaiting_user' && task.status !== 'awaiting_approval'))
      return 'skipped'
    if (!(await letsTheQueueGo(tx, taskId))) return 'skipped'
    const queued = await tx.taskQueuedMessage.findMany({
      where: { taskId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    if (queued.length === 0) return 'skipped'

    // The reserve first: a refusal throws before anything is written.
    const attempt = await nextAttempt(tx, { id: taskId, ...task }, now)
    let last: bigint | null = null
    for (const words of queued) {
      const payload: FeedRequestPayload = {
        v: 1,
        kind: 'queued',
        authorId: words.authorId,
        requestId: words.requestId,
        text: words.text,
        ...(words.attachments.length > 0 ? { attachments: words.attachments } : {}),
        ...(words.plan ? { plan: true as const } : {}),
      }
      last = await insertFeedEvent(tx, { taskId, row: { type: 'feed.request', payload } })
    }
    await tx.taskQueuedMessage.deleteMany({
      where: { taskId, id: { in: queued.map((words) => words.id) } },
    })
    const moved = await tx.task.updateMany({
      where: { id: taskId, status: task.status, attempt: task.attempt },
      data: { status: 'queued', waiting: null, attempt, archivedAt: null },
    })
    if (moved.count !== 1) throw new Error(`queue_drain: task ${taskId} moved meanwhile`)
    await enqueueAgentTurn(tx, { taskId, attempt, requestEventId: String(last) })
    return 'moved'
  }
}

/**
 * The newest request is «Отправить сейчас», or the newest ending is one after which the dialog
 * waits for the client's words: an answer, an agent's or a browser's question, a candidate. A
 * question of the platform about credits waits for «Продолжить», not for words (ВВ3).
 */
export async function letsTheQueueGo(tx: Pick<Tx, 'taskEvent'>, taskId: string): Promise<boolean> {
  const request = await tx.taskEvent.findFirst({
    where: { taskId, type: 'feed.request' },
    orderBy: { id: 'desc' },
    select: { id: true, payload: true },
  })
  const pressed = request ? readFeedRow('feed.request', request.payload) : null
  if (pressed?.type === 'feed.request' && pressed.kind === 'interrupt') return true
  const ending = await tx.taskEvent.findFirst({
    where: { taskId, type: { in: [...ENDINGS] } },
    orderBy: { id: 'desc' },
    select: { id: true, type: true, payload: true },
  })
  if (!ending || !(LETTING as readonly string[]).includes(ending.type)) return false
  // The ending answers words written before it, not after: a request after it is already a pass.
  if (request && request.id > ending.id) return false
  if (ending.type !== 'feed.question') return true
  const question = readFeedRow('feed.question', ending.payload)
  return question.type === 'feed.question' && question.kind !== 'ceiling'
}

/**
 * The attempt the next pass runs in, and its reserve — what `task.message` does
 * (`nextPassAttempt` of the procedures): a chain still active goes on and its reserve is moved
 * on; a charged one is followed by the next attempt with a reserve placed now.
 */
async function nextAttempt(
  tx: Tx,
  task: { id: string; attempt: number; workspaceId: string; billable: boolean },
  now: Date,
): Promise<number> {
  const active = await tx.creditHold.count({ where: { taskId: task.id, status: 'active' } })
  if (active > 0) {
    await extendTaskHolds(tx, { taskId: task.id, expiresAt: taskHoldExpiry(now, 'waiting') })
    return task.attempt
  }
  if (!task.billable) return task.attempt
  const attempt = task.attempt + 1
  await placeCreditHold(tx, {
    workspaceId: task.workspaceId,
    taskId: task.id,
    attempt,
    now,
    expiresAt: taskHoldExpiry(now, 'waiting'),
    follows: 'message',
  })
  return attempt
}
