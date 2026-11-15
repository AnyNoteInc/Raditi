import { recordRunOutcome, type PrismaClient, type ScheduledRunOutcome } from '@repo/db'
import {
  DomainError,
  isDomainError,
  missingRequiredConsents,
  reasoningEffortSchema,
  scheduleLimits,
  scheduledRunReasons,
  type ScheduledRunReason,
  type ScheduleIntakeResponse,
} from '@repo/domain'

import { isManagerRole, memberRole } from '../chat/access.ts'
import type { ChatContext } from '../chat/context.ts'
import { createDialog } from '../chat/tasks.ts'
import { loadLatestConsents } from '../consents.ts'
import { deterministicUuidV7 } from '../deterministic-uuid.ts'

// A run of a scheduled task starts its chat (docs/plan/82-scheduled-tasks.md, §4.3, Зп17–Зп24):
// core wrote the run with a snapshot of the task under its lock and hands its id here; web starts
// the chat by the same `createDialog` as the cabinet, from the snapshot, never from the task as it
// is now. No long transaction: every step reads, the chat is made by its own transaction, and the
// outcome is written by a short one only while the run still waits. The id of the chat is derived
// from the run, so a repeat of the delivery finds the chat the first one made.

const HOUR_MS = 60 * 60 * 1000

/** The namespace of the ids of chats of runs (`deterministicUuidV7`). */
export const SCHEDULE_CHAT_NAMESPACE = 'schedule'

/** The id of the chat of a run: the same for every delivery of it (Зп20). */
export const scheduledChatId = (run: { id: string; dueAt: Date }): string =>
  deterministicUuidV7(SCHEDULE_CHAT_NAMESPACE, run.id, run.dueAt)

/**
 * «Запустить сейчас» did not start (Зп24): the reason is told in the cabinet in words, without a
 * notice. A refusal of `createDialog` itself is told by its own error instead.
 */
export const scheduleRunRefused = (reason: ScheduledRunReason) =>
  new DomainError('SCHEDULE_RUN_REFUSED', 'The run of the scheduled task did not start', 409, {
    reason,
  })

/** What a start came to, with the refusal of `createDialog` that refused it, if one did. */
export interface StartedRun {
  response: ScheduleIntakeResponse
  /** The error `createDialog` refused the chat with: «Запустить сейчас» shows it as it is. */
  refusal?: DomainError
}

/**
 * Why `createDialog` refused the chat of a run (§4.3): a reason of the client or of the platform —
 * recorded, the delivery done — or `retry`: a failure that may pass, so the run keeps waiting and
 * core delivers it again. NOT_FOUND is never read as a project that is gone: that is read from the
 * database before (`project_gone`), and a NOT_FOUND here is a fault of the platform.
 */
export function refusalReasonOf(error: unknown): ScheduledRunReason | 'retry' {
  if (!isDomainError(error)) return 'retry'
  switch (error.code) {
    case 'BILLING_NOT_ENOUGH_CREDITS':
      return 'no_credits'
    case 'BILLING_TASK_NEEDS_SUBSCRIPTION':
      return 'needs_tariff'
    case 'BILLING_CREDITS_HELD':
      return 'credits_held'
    case 'BILLING_WINDOW_LIMIT_REACHED':
      return 'weekly_limit'
    case 'BILLING_DAILY_LIMIT_REACHED':
      return 'daily_limit'
    case 'BILLING_CREDIT_RATE_MISSING':
      return 'platform'
    case 'TASK_NOT_ACCEPTED': {
      const reason = (error.details as { reason?: unknown } | undefined)?.reason
      return reason === 'site_not_active' || reason === 'not_synthetic'
        ? 'project_unavailable'
        : 'platform'
    }
    case 'WORKSPACE_KEY_UNAVAILABLE':
      return 'retry'
  }
  if (error.code.startsWith('TASK_TEXT_')) return 'text_refused'
  // 503 and any other failure of the server may pass: core asks again (8 attempts, Зп21).
  if (error.httpStatus >= 500) return 'retry'
  return 'platform'
}

/** The outcome a run recorded, as web answers core. */
function responseOf(run: {
  status: string
  reason: string | null
  taskId: string | null
}): ScheduleIntakeResponse | null {
  if (run.status === 'started' && run.taskId !== null)
    return { outcome: 'started', taskId: run.taskId }
  if (run.status !== 'refused' && run.status !== 'skipped') return null
  const reason = (scheduledRunReasons as readonly string[]).includes(run.reason ?? '')
    ? (run.reason as ScheduledRunReason)
    : 'platform'
  return { outcome: run.status, reason }
}

const runSelect = {
  id: true,
  scheduledTaskId: true,
  dueAt: true,
  trigger: true,
  status: true,
  reason: true,
  taskId: true,
  siteId: true,
  name: true,
  instructions: true,
  effort: true,
  createdAt: true,
} as const

/**
 * Writes the outcome while the run waits (§4.3, (е)) and answers what the run holds then: a sweep
 * or another delivery that recorded it first is answered with what it recorded.
 */
async function record(
  db: PrismaClient,
  runId: string,
  outcome: ScheduledRunOutcome,
  now: Date,
): Promise<ScheduleIntakeResponse> {
  await recordRunOutcome(db, runId, outcome, now)
  const run = await db.scheduledRun.findUnique({
    where: { id: runId },
    select: { status: true, reason: true, taskId: true },
  })
  return (
    (run && responseOf(run)) ??
    (outcome.status === 'started'
      ? { outcome: 'started', taskId: outcome.taskId }
      : { outcome: outcome.status, reason: outcome.reason })
  )
}

/**
 * Starts the chat of a run (§4.3), the steps in their order: (а) a run that does not wait answers
 * what it recorded — one there is not, `skipped/paused`; (б) its chat is there (deleted too): it is
 * `started` with it; (в) it came late — a later run of the task waits or started, or its moment is
 * older than the catch-up limit — `skipped/missed`; its task was deleted, or switched off since a
 * run of its schedule was written — `skipped/paused`; (г) its project was deleted, or the creator
 * no longer manages its workspace — refused, and the task stops (`project_gone`, `member_gone`);
 * the creator has documents to accept — `refused/consent`; (д) `createDialog` from the snapshot,
 * named by the task, its preview built on demand; (е) the outcome.
 *
 * Throws only for a failure that may pass — Vault, a refusal of 503, what is not a DomainError — so
 * the run keeps waiting and core delivers it again.
 */
export async function startRun(
  db: PrismaClient,
  chat: ChatContext,
  input: { runId: string; now: Date },
): Promise<StartedRun> {
  const { now } = input
  const run = await db.scheduledRun.findUnique({ where: { id: input.runId }, select: runSelect })
  // (а)
  if (run === null) return { response: { outcome: 'skipped', reason: 'paused' } }
  const recorded = responseOf(run)
  if (recorded !== null) return { response: recorded }
  if (run.status !== 'pending') return { response: { outcome: 'skipped', reason: 'paused' } }

  // (б)
  const taskId = scheduledChatId(run)
  const made = await db.task.findUnique({ where: { id: taskId }, select: { id: true } })
  if (made !== null)
    return { response: await record(db, run.id, { status: 'started', taskId }, now) }

  // (в)
  const skip = (reason: ScheduledRunReason) =>
    record(db, run.id, { status: 'skipped', reason }, now).then((response) => ({ response }))
  const later = await db.scheduledRun.findFirst({
    where: {
      scheduledTaskId: run.scheduledTaskId,
      id: { not: run.id },
      dueAt: { gt: run.dueAt },
      status: { in: ['pending', 'started'] },
    },
    select: { id: true },
  })
  if (later !== null || now.getTime() - run.dueAt.getTime() > scheduleLimits.catchUpHours * HOUR_MS)
    return skip('missed')
  const task = await db.scheduledTask.findUnique({
    where: { id: run.scheduledTaskId },
    select: {
      createdById: true,
      workspaceId: true,
      enabled: true,
      pausedReason: true,
      deletedAt: true,
    },
  })
  if (task === null || task.deletedAt !== null) return skip('paused')
  // A run of the schedule of a task switched off since it was written; «Один раз» is switched off
  // by the very claim that wrote its run (`completed`), and «Запустить сейчас» runs a paused one.
  if (run.trigger === 'schedule' && !task.enabled && task.pausedReason !== 'completed')
    return skip('paused')

  // (г)
  const refuse = (reason: ScheduledRunReason, refusal?: DomainError) =>
    record(db, run.id, { status: 'refused', reason }, now).then((response) => ({
      response,
      ...(refusal === undefined ? {} : { refusal }),
    }))
  const userId = task.createdById
  let workspaceId = task.workspaceId
  if (run.siteId !== null) {
    const site = await db.site.findUnique({
      where: { id: run.siteId },
      select: { workspaceId: true, deletedAt: true },
    })
    if (site === null || site.deletedAt !== null) return refuse('project_gone')
    workspaceId = site.workspaceId
  }
  if (!isManagerRole(await memberRole(db, workspaceId, userId))) return refuse('member_gone')
  if (missingRequiredConsents(await loadLatestConsents(db, userId)).length > 0)
    return refuse('consent')

  // (д)
  const effort = reasoningEffortSchema.catch('high').parse(run.effort)
  let created: string
  try {
    created = (
      await createDialog(db, chat, {
        userId,
        siteId: run.siteId,
        taskId,
        text: run.instructions,
        effort,
        title: run.name,
        preview: 'on_demand',
        now,
      })
    ).taskId
  } catch (error) {
    const reason = refusalReasonOf(error)
    if (reason === 'retry') throw error
    return refuse(reason, error as DomainError)
  }
  // (е)
  return { response: await record(db, run.id, { status: 'started', taskId: created }, now) }
}

/** The intake of web (`/api/webhooks/scheduled-runs`): the answer core gets for the run. */
export async function startScheduledRun(
  db: PrismaClient,
  chat: ChatContext,
  input: { runId: string; now: Date },
): Promise<ScheduleIntakeResponse> {
  return (await startRun(db, chat, input)).response
}
