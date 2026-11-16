import { z } from 'zod'

import type { QueueName } from '../ports/job-queue.ts'

/**
 * The runs of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп14, Зп19–Зп24, §4.3): core
 * writes a run under the lock of its task and hands it to web, which starts its chat by the
 * same `createDialog` as the cabinet. Ids only travel; the words are read from PostgreSQL.
 */

/** By the schedule, or «Запустить сейчас» (Зп24). */
export const scheduledRunTriggers = ['schedule', 'manual'] as const
export type ScheduledRunTrigger = (typeof scheduledRunTriggers)[number]

/** `pending` until web answers; then started with its chat, refused, or skipped. */
export const scheduledRunStatuses = ['pending', 'started', 'refused', 'skipped'] as const
export type ScheduledRunStatus = (typeof scheduledRunStatuses)[number]

/**
 * Why a run did not start a chat (Зп14, Зп21, Зп48, §4.3). `project_gone` — the project of the task
 * is in «Архив» or in the trash; `project_unavailable` — the sign-in with GitLab of its repository
 * has to be renewed (docs/plan/84-projects.md, ПР19).
 */
export const scheduledRunReasons = [
  'no_credits',
  'needs_tariff',
  'credits_held',
  'weekly_limit',
  'daily_limit',
  'consent',
  'text_refused',
  'previous_running',
  'missed',
  'paused',
  'platform',
  'project_gone',
  'project_unavailable',
] as const
export type ScheduledRunReason = (typeof scheduledRunReasons)[number]

/** «Не запустилась: <причина>», «Пропущено: <причина>» (Зп5). */
export const scheduledRunReasonText: Readonly<Record<ScheduledRunReason, string>> = Object.freeze({
  no_credits: 'не хватило кредитов',
  needs_tariff: 'нужен тариф',
  credits_held: 'кредиты заняты другими задачами',
  weekly_limit: 'исчерпан недельный лимит',
  daily_limit: 'исчерпан дневной лимит',
  consent: 'нужно принять новые условия в кабинете',
  text_refused: 'инструкцию нельзя отправить агенту',
  previous_running: 'предыдущий запуск ещё шёл',
  missed: 'платформа была недоступна',
  paused: 'задача была на паузе',
  platform: 'сбой платформы',
  project_gone: 'проект в архиве или удалён',
  project_unavailable: 'нужно войти в GitLab заново',
})

/**
 * Refusals for a reason of the client: three in a row pause the task (Зп22); a sign-in with GitLab
 * to renew among them (docs/plan/84-projects.md, ПР19).
 */
export const clientRefusalReasons = [
  'no_credits',
  'needs_tariff',
  'weekly_limit',
  'daily_limit',
  'consent',
  'project_unavailable',
] as const satisfies readonly ScheduledRunReason[]
export type ClientRefusalReason = (typeof clientRefusalReasons)[number]

export const isClientRefusalReason = (reason: string): reason is ClientRefusalReason =>
  (clientRefusalReasons as readonly string[]).includes(reason)

/**
 * Why a task is off without the client's word (Зп15, Зп22, Зп48). `project_gone` — its project went
 * into «Архив» or the trash; `unconfirmed` — the agent set it up in a chat of a project with a
 * repository, and only the client turns it on (docs/plan/84-projects.md, ПР19).
 */
export const schedulePausedReasons = [
  'completed',
  'not_accepted',
  'refused',
  'project_gone',
  'unconfirmed',
] as const
export type SchedulePausedReason = (typeof schedulePausedReasons)[number]

/** The state of a task that stopped by itself, in its row of the list (Зп5); «Завершена» takes its date. */
export const schedulePausedReasonText: Readonly<Record<SchedulePausedReason, string>> =
  Object.freeze({
    completed: 'Завершена',
    not_accepted: 'Остановлена: задачи пока не принимаются',
    refused: 'Остановлена после трёх отказов подряд',
    project_gone: 'Остановлена: проект в архиве или удалён',
    unconfirmed: 'Ждёт, пока вы её включите',
  })

// ---------------------------------------------------------------------------------------------
// core → web (§4.3)
// ---------------------------------------------------------------------------------------------

/** The queue of the tick and the starts in core, and its jobs (Зп19). */
export const SCHEDULE_QUEUE = 'schedules' satisfies QueueName
export const SCHEDULE_TICK_JOB = 'schedule.tick'
export const SCHEDULE_START_JOB = 'schedule.start'

/** The job and the outbox event of a run: its id only. */
export const scheduleStartJobSchema = z.strictObject({ runId: z.uuid() })
export type ScheduleStartJob = z.infer<typeof scheduleStartJobSchema>

/** The outbox key of a run: `schedule.start:<runId>` — one start per run. */
export const scheduleStartDedupeKey = (job: ScheduleStartJob): string =>
  `${SCHEDULE_START_JOB}:${job.runId}`

/** The path of the intake of web (`SCHEDULE_INTAKE_URL` ends with it) and its secret's header. */
export const SCHEDULE_INTAKE_PATH = '/api/webhooks/scheduled-runs'
export const SCHEDULE_INTAKE_SECRET_HEADER = 'x-raditi-schedule-secret'
/** The body of the intake, at most. */
export const SCHEDULE_INTAKE_MAX_BYTES = 1024

/** What core posts to web: the run, nothing of its words. */
export const scheduleIntakeRequestSchema = z.strictObject({ runId: z.uuid() })
export type ScheduleIntakeRequest = z.infer<typeof scheduleIntakeRequestSchema>

const reason = z.enum(scheduledRunReasons)

/** What web answers: the chat of the run, or why there is none. */
export const scheduleIntakeResponseSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('started'), taskId: z.uuid() }),
  z.strictObject({ outcome: z.literal('refused'), reason }),
  z.strictObject({ outcome: z.literal('skipped'), reason }),
])
export type ScheduleIntakeResponse = z.infer<typeof scheduleIntakeResponseSchema>
