import { Prisma, type PrismaClient } from '@repo/db'
import {
  scheduledRunReasons,
  type ScheduledRunReason,
  type ScheduledRunState,
  type ScheduledRunStopCause,
  type TaskStatus,
} from '@repo/domain'

import { ANSWERED, FAILED, STOPPED } from '../chat/dialog-list.ts'

// What came of the runs of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп5, Зп6): a run that
// started is told by the state of its chat, read by the same conditions as the list of chats
// (`dialog-list.ts`); one that did not, by the reason it was given.

/** The state of the chat of a run, as the list of chats reads it. */
export interface RunChatState {
  status: TaskStatus
  deleted: boolean
  answered: boolean
  failed: boolean
  /** `STOPPED` of the list: why the open chat stopped at a limit; null — it did not. */
  stopped: 'credits' | 'weekly_limit' | 'limit' | null
}

/** A run as its row has it. */
export interface RunRow {
  status: string
  reason: string | null
  missedCount: number
  /** The end of a gap of missed runs; null — another row, or one written before it was kept. */
  missedUntil: Date | null
  taskId: string | null
}

const reasonOf = (reason: string | null): ScheduledRunReason =>
  (scheduledRunReasons as readonly string[]).includes(reason ?? '')
    ? (reason as ScheduledRunReason)
    : // A reason this code does not know is told as a fault of the platform, never guessed.
      'platform'

const stopCauseOf = (stopped: RunChatState['stopped']): ScheduledRunStopCause | null =>
  stopped === 'credits' || stopped === 'weekly_limit' ? stopped : null

/**
 * The state of one run (Зп5). Its chat: `undefined` — not read (none, or gone from the database),
 * told as deleted. A chat at work is «Выполняется»; one in a release — its changes were ready; one
 * that ended is done or not; an open one waits for the client, brought changes, failed or stopped
 * at a limit — the newest row that ends a pass says which.
 */
export function runStateOf(run: RunRow, chat: RunChatState | undefined): ScheduledRunState {
  switch (run.status) {
    case 'pending':
      return { kind: 'pending' }
    case 'refused':
      return { kind: 'refused', reason: reasonOf(run.reason) }
    case 'skipped':
      return {
        kind: 'skipped',
        reason: reasonOf(run.reason),
        missedCount: run.missedCount,
        missedUntil: run.reason === 'missed' ? run.missedUntil : null,
      }
  }
  if (chat === undefined || chat.deleted) return { kind: 'chat_deleted' }
  switch (chat.status) {
    case 'queued':
    case 'preparing':
    case 'running':
      return { kind: 'running' }
    case 'deploying':
    case 'verifying':
      return { kind: 'ready' }
    case 'done':
      return { kind: 'done' }
    case 'failed':
    case 'rolled_back':
    case 'cancelled':
      return { kind: 'failed' }
    case 'awaiting_user':
    case 'awaiting_approval':
      if (chat.stopped !== null) return { kind: 'stopped', cause: stopCauseOf(chat.stopped) }
      if (chat.failed) return { kind: 'failed' }
      if (chat.status === 'awaiting_approval') return { kind: 'ready' }
      return chat.answered ? { kind: 'done' } : { kind: 'waiting' }
  }
}

/** The states of the chats of runs, by the id of the chat; one query for a page of runs. */
export async function runChatStates(
  db: Pick<PrismaClient, '$queryRaw'>,
  taskIds: readonly string[],
): Promise<Map<string, RunChatState>> {
  const ids = [...new Set(taskIds)]
  if (ids.length === 0) return new Map()
  const rows = await db.$queryRaw<Array<RunChatState & { id: string }>>(Prisma.sql`
    SELECT t.id, t.status::text AS status, t.deleted_at IS NOT NULL AS deleted,
      ${ANSWERED} AS answered, ${FAILED} AS failed, ${STOPPED} AS stopped
    FROM tasks t
    WHERE t.id = ANY(${ids}::uuid[])`)
  return new Map(rows.map(({ id, ...state }) => [id, state]))
}

/** The states of runs (Зп5, Зп6), in their order. */
export async function runStates(
  db: Pick<PrismaClient, '$queryRaw'>,
  runs: readonly RunRow[],
): Promise<ScheduledRunState[]> {
  const chats = await runChatStates(
    db,
    runs.flatMap((run) => (run.status === 'started' && run.taskId !== null ? [run.taskId] : [])),
  )
  return runs.map((run) => runStateOf(run, run.taskId === null ? undefined : chats.get(run.taskId)))
}
