import type { PrismaClient } from '@repo/db'
import type { TaskSignal } from '@repo/domain'

import { accessibleTask, taskNotFound } from './access.ts'

/**
 * Where the signals of chats come from (spec §7, «Лента для клиента»): web listens to Redis, core
 * relays there what PostgreSQL said once a change of a chat committed. A signal says «read now»;
 * the page reads by its cursor, so a lost or repeated one changes nothing but the time.
 */
export interface TaskSignals {
  /** Calls `listener` with every signal of the task and every `resync`, until it is unsubscribed. */
  subscribe(taskId: string, listener: (signal: TaskSignal) => void): () => void
}

/** How often a stream checks again that its reader may still read the chat. */
export const SIGNALS_RECHECK_MS = 15_000

/**
 * `task.signals`: the signals of one chat for a member of its workspace, from the moment of the
 * request. The first one is `resync` — the page reads what it missed while it connected. Whether
 * the reader may still read the chat is checked again every `recheckMs`: a member removed, a chat
 * or a project deleted ends the stream, and the page goes on by its polls, which are refused.
 */
export async function* readTaskSignals(
  db: Pick<PrismaClient, 'task'>,
  signals: TaskSignals,
  input: { userId: string; taskId: string; signal?: AbortSignal; recheckMs?: number },
): AsyncGenerator<{ signal: TaskSignal }> {
  const allowed = () =>
    db.task.findFirst({ where: accessibleTask(input.userId, input.taskId), select: { id: true } })
  const task = await allowed()
  if (task === null) throw taskNotFound()
  const recheckMs = input.recheckMs ?? SIGNALS_RECHECK_MS
  const queue: TaskSignal[] = []
  let wake: (() => void) | null = null
  const unsubscribe = signals.subscribe(task.id, (signal) => {
    if (!queue.includes(signal)) queue.push(signal)
    wake?.()
  })
  const stop = () => wake?.()
  input.signal?.addEventListener('abort', stop)
  let checkedAt = Date.now()
  try {
    yield { signal: 'resync' }
    while (!input.signal?.aborted) {
      if (queue.length === 0) {
        const left = Math.max(0, checkedAt + recheckMs - Date.now())
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left)
          wake = () => {
            clearTimeout(timer)
            resolve()
          }
        })
        wake = null
      }
      if (input.signal?.aborted) return
      if (Date.now() - checkedAt >= recheckMs) {
        if ((await allowed()) === null) return
        checkedAt = Date.now()
      }
      while (queue.length > 0) yield { signal: queue.shift()! }
    }
  } finally {
    unsubscribe()
    input.signal?.removeEventListener('abort', stop)
  }
}
