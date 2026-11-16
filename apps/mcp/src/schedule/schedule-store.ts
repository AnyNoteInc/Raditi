import {
  listScheduledTasks,
  pendingScheduleChanges,
  reserveScheduleChange,
  type PrismaClient,
} from '@repo/db'
import { scheduleTriggerListSchema } from '@repo/domain'

import type { McpScheduleStore } from './schedule-service.ts'

type Db = Pick<PrismaClient, '$transaction' | 'scheduledTask' | 'scheduleReservation' | 'task'>

/**
 * The store of the `schedule` tools: the functions of @repo/db over the role's database
 * (docs/plan/82-scheduled-tasks.md, §4.2). Rights, limits and the checks of a reservation are
 * theirs; this only reads what the tools answer.
 */
export function postgresScheduleStore(db: Db): McpScheduleStore {
  return {
    author: async (taskId) => {
      const chat = await db.task.findUnique({
        where: { id: taskId },
        select: {
          createdById: true,
          projectId: true,
          createdBy: { select: { timezone: true } },
        },
      })
      return chat?.createdById
        ? {
            userId: chat.createdById,
            timezone: chat.createdBy?.timezone ?? null,
            projectId: chat.projectId,
          }
        : null
    },
    list: async (input) =>
      (await listScheduledTasks(db, input)).map((task) => {
        const run = task.runs[0]
        const triggers = scheduleTriggerListSchema.safeParse(task.triggers)
        return {
          id: task.id,
          name: task.name,
          instructions: task.instructions,
          effort: task.effort,
          triggers: triggers.success ? triggers.data : null,
          timezone: task.timezone,
          enabled: task.enabled,
          notify: task.notify,
          pausedReason: task.pausedReason,
          nextRunAt: task.nextRunAt,
          lastRun: run
            ? { dueAt: run.dueAt, trigger: run.trigger, status: run.status, reason: run.reason }
            : null,
        }
      }),
    pending: async (taskId, turnNo) =>
      (await pendingScheduleChanges(db, taskId, turnNo)).map((row) => {
        const name = (row.payload as { name?: unknown } | null)?.name
        return {
          reservedId: row.id,
          kind: row.kind,
          scheduleId: row.scheduleId,
          name: typeof name === 'string' ? name : null,
        }
      }),
    reserve: (input) => reserveScheduleChange(db, input),
  }
}
