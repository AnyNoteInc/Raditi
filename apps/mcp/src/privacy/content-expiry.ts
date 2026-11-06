import { Prisma } from '@repo/db'
import { terminalTaskStatuses } from '@repo/domain'

/** The undo window: «Отменить» works this long after the task has finished. */
export const CONTENT_SNAPSHOT_TTL_MS = 7 * 24 * 60 * 60_000
/**
 * SQL: the content of the task is over, so its snapshots and its contact map may go. It was
 * retired, or it reached a final status longer ago than the undo window. `task` is the name
 * the query gives to the tasks table.
 */
export const contentExpiredSql = (task: 't' | 'tasks', ttlMs = CONTENT_SNAPSHOT_TTL_MS) => {
  const t = Prisma.raw(task)
  return Prisma.sql`(${t}.content_retired_at IS NOT NULL OR
    (${t}.status = ANY(${[...terminalTaskStatuses]}::"TaskStatus"[])
      AND ${t}.finished_at <= clock_timestamp() - make_interval(secs => ${ttlMs / 1000}::double precision)))`
}
