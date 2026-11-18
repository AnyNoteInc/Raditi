// Signals of a changed chat (spec §7, «Лента для клиента»; перенос ускорений, 18.11.2026,
// docs/plan/86-speedups.md). A committed change of what the page of a chat reads sends
// `<task id>:<kind>` on the PostgreSQL channel `raditi_task` (triggers of
// 20261118140000_task_signals); core relays it to the
// Redis channel of the task, and web tells the page, which reads the feed by its cursor at once.
// A signal is only a hint: a lost one costs the time of the next poll, a repeated one a read.

/** The channel of PostgreSQL the triggers notify on. */
export const TASK_SIGNAL_PG_CHANNEL = 'raditi_task'

/** `feed` — the head or the rows of the feed; `activity` — the agent's output of a turn. */
export const taskSignalKinds = ['feed', 'activity'] as const
export type TaskSignalKind = (typeof taskSignalKinds)[number]

/** What a page is told: a kind of change, or `resync` — signals may have been lost meanwhile. */
export type TaskSignal = TaskSignalKind | 'resync'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The Redis channel of one task's signals. */
export const taskSignalChannel = (taskId: string): string => `raditi:task:${taskId.toLowerCase()}`

/**
 * Said to every page when core could not hear PostgreSQL for a while: every open chat reads its
 * feed again, by its cursor.
 */
export const TASK_SIGNALS_RESYNC_CHANNEL = 'raditi:tasks:resync'

/** The payload of a notification, or null when it is not one of the triggers'. */
export function parseTaskSignal(payload: string): { taskId: string; kind: TaskSignalKind } | null {
  const at = payload.lastIndexOf(':')
  if (at < 0) return null
  const taskId = payload.slice(0, at).toLowerCase()
  const kind = payload.slice(at + 1)
  if (!UUID.test(taskId) || !(taskSignalKinds as readonly string[]).includes(kind)) return null
  return { taskId, kind: kind as TaskSignalKind }
}

/** The message of a task's Redis channel, or null when it is not a kind. */
export function readTaskSignal(message: string): TaskSignalKind | null {
  return (taskSignalKinds as readonly string[]).includes(message)
    ? (message as TaskSignalKind)
    : null
}
