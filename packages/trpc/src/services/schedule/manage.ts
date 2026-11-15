import { randomUUID } from 'node:crypto'

import {
  countSiteSchedules,
  createScheduledTask,
  deleteScheduledTask,
  dropPendingRun,
  findPersonalWorkspace,
  insertManualRun,
  listScheduledTasks,
  readScheduledTask,
  rememberUserTimezone,
  scheduleTriggersOf,
  setScheduledTaskEnabled,
  updateScheduledTask,
  workspaceUsageTerms,
  type PrismaClient,
  type ScheduledTaskPatch,
} from '@repo/db'
import {
  averageTaskCredits,
  badRequest,
  DEFAULT_SCHEDULE_TIMEZONE,
  dueCountBetween,
  DomainError,
  hasScheduleTemplatePlaceholder,
  nextRunOf,
  scheduledRunReasons,
  scheduleNotFound,
  scheduleTemplateOf,
  scheduleTemplatePlaceholder,
  scheduleTimezoneSchema,
  scheduleTriggerListSchema,
  type AppEnv,
  type ReasoningEffort,
  type ScheduledRunReason,
  type ScheduledRunState,
  type ScheduledRunTrigger,
  type ScheduleTrigger,
  type SchedulePausedReason,
} from '@repo/domain'

import type { ChatContext } from '../chat/context.ts'
import { personalWorkspaceOf } from '../chat/dialog-lock.ts'
import { requestPayload, requestText } from '../chat/request-text.ts'
import { accessibleSite, siteNotFound } from '../site-basics.ts'
import { runStates } from './outcomes.ts'
import { scheduleRunRefused, startRun } from './runs.ts'

// The scheduled tasks of the cabinet (docs/plan/82-scheduled-tasks.md, §4.5): «Ваши», the page of a
// task with its runs, and what the window and the switch do with one. The rules of a task — its
// rights, the 20 of a workspace, the schedules and the zone — are of `@repo/db` and `@repo/domain`;
// here the words of the instructions are checked as the words of a chat (Зп26), a template (Зп9),
// and the workspace a task goes to: of its project, or the creator's personal one (Зп25).

const DAY_MS = 24 * 60 * 60 * 1000

/** A template about a site saved without a project (Зп9): the window offers no «Создать» then. */
export const scheduleTemplateNeedsProject = () =>
  new DomainError('SCHEDULE_TEMPLATE_NEEDS_PROJECT', 'This template is about a site', 400)

/** A run of a task, as «Ваши» and the page of a task show it (Зп5, Зп6). */
export interface ScheduleRunView {
  id: string
  dueAt: Date
  trigger: ScheduledRunTrigger
  state: ScheduledRunState
  /** Its chat; null — none started, or it was deleted («Чат удалён»). */
  chat: { id: string; title: string | null } | null
  createdAt: Date
  startedAt: Date | null
}

/** A scheduled task of its creator (Зп5–Зп7). */
export interface ScheduleView {
  id: string
  name: string
  instructions: string
  effort: ReasoningEffort
  triggers: ScheduleTrigger[]
  timezone: string
  enabled: boolean
  notify: boolean
  /** Why it is off by itself; null — on, or paused by the client. */
  pausedReason: SchedulePausedReason | null
  /** With `refused`: the reason of the last refusal of the three (Зп22). */
  lastRefusalReason: ScheduledRunReason | null
  nextRunAt: Date | null
  lastRunAt: Date | null
  createdVia: 'manual' | 'template' | 'chat'
  templateSlug: string | null
  /**
   * null — without a project. `deleted` — its project was deleted (Зп22): the task stays bound to
   * it, stopped, until the client moves it to another project or to none — shown «Проект удалён».
   */
  project: { id: string; name: string; deleted: boolean } | null
  createdAt: Date
  updatedAt: Date
  /** The newest run; null — none yet. */
  lastRun: ScheduleRunView | null
}

/** A task with its last 50 runs, the newest first: its page (Зп6), and what a change answers. */
export type ScheduleDetail = ScheduleView & { runs: ScheduleRunView[] }

type TaskRow = Awaited<ReturnType<typeof listScheduledTasks>>[number]
type RunRowOfTask = TaskRow['runs'][number]

const reasonOrNull = (reason: string | null): ScheduledRunReason | null =>
  (scheduledRunReasons as readonly string[]).includes(reason ?? '')
    ? (reason as ScheduledRunReason)
    : null

function runView(run: RunRowOfTask, state: ScheduledRunState): ScheduleRunView {
  return {
    id: run.id,
    dueAt: run.dueAt,
    trigger: run.trigger as ScheduledRunTrigger,
    state,
    // A chat deleted, or of a project deleted — it left the cabinet with it: «Чат удалён» (Зп6).
    chat:
      run.task === null ||
      run.task.deletedAt !== null ||
      (run.task.site !== null && run.task.site.deletedAt !== null)
        ? null
        : { id: run.task.id, title: run.task.title },
    createdAt: run.createdAt,
    startedAt: run.startedAt,
  }
}

function taskView(row: TaskRow, lastRun: ScheduleRunView | null): ScheduleView {
  return {
    id: row.id,
    name: row.name,
    instructions: row.instructions,
    effort: row.effort as ReasoningEffort,
    triggers: scheduleTriggersOf(row),
    timezone: row.timezone,
    enabled: row.enabled,
    notify: row.notify,
    pausedReason: row.pausedReason as SchedulePausedReason | null,
    lastRefusalReason: reasonOrNull(row.lastRefusalReason),
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    createdVia: row.createdVia as ScheduleView['createdVia'],
    templateSlug: row.templateSlug,
    project:
      row.site === null
        ? null
        : { id: row.site.id, name: row.site.name, deleted: row.site.deletedAt !== null },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRun,
  }
}

async function viewsOf(db: PrismaClient, rows: TaskRow[]): Promise<ScheduleView[]> {
  const runs = rows.flatMap((row) => row.runs.slice(0, 1))
  const states = await runStates(db, runs)
  const byRun = new Map(runs.map((run, index) => [run.id, states[index]!]))
  return rows.map((row) => {
    const run = row.runs[0]
    return taskView(row, run === undefined ? null : runView(run, byRun.get(run.id)!))
  })
}

/** «Ваши» (Зп25): the tasks the user created, the newest first, each with its latest run. */
export async function listSchedules(db: PrismaClient, userId: string): Promise<ScheduleView[]> {
  return viewsOf(db, await listScheduledTasks(db, { userId }))
}

/** The page of a task (Зп6): it and its last 50 runs; another's or a deleted one — not found. */
export async function readSchedule(
  db: PrismaClient,
  input: { userId: string; scheduleId: string },
): Promise<ScheduleDetail> {
  const row = await readScheduledTask(db, input)
  const states = await runStates(db, row.runs)
  const runs = row.runs.map((run, index) => runView(run, states[index]!))
  return { ...taskView(row, runs[0] ?? null), runs }
}

/**
 * The words of the instructions, as the words of a chat (Зп26): empty, too long, a password or a
 * key — refused in the client's terms; and the place for the addresses of «Конкуренты» (Зп9).
 */
function checkedInstructions(userId: string, text: string): string {
  const words = requestText(text)
  requestPayload({ v: 1, kind: 'first', authorId: userId, requestId: randomUUID(), text: words })
  if (hasScheduleTemplatePlaceholder(words)) throw scheduleTemplatePlaceholder()
  return words
}

/**
 * The workspace of a task (Зп25): of its project — one the user can open, not deleted — or the
 * creator's personal workspace, made with the gift of the registration for a new user. Whether
 * they manage it, the rules of `@repo/db` ask under its lock.
 */
async function workspaceOf(
  db: PrismaClient,
  appEnv: AppEnv,
  input: { userId: string; siteId: string | null },
): Promise<string> {
  if (input.siteId === null)
    return (await personalWorkspaceOf(db, { userId: input.userId, appEnv })).id
  const site = await db.site.findFirst({
    where: accessibleSite(input.userId, input.siteId),
    select: { workspaceId: true },
  })
  if (site === null) throw siteNotFound()
  return site.workspaceId
}

/** A template of §4.6 named by a task: known, and about a site only with a project (Зп9). */
function checkTemplate(slug: string | null, siteId: string | null): void {
  if (slug === null) return
  const template = scheduleTemplateOf(slug)
  if (template === undefined) throw badRequest('Unknown template of a scheduled task')
  if (template.project === 'required' && siteId === null) throw scheduleTemplateNeedsProject()
}

export interface ScheduleInput {
  userId: string
  siteId: string | null
  name: string
  instructions: string
  effort: ReasoningEffort
  triggers: ScheduleTrigger[]
  timezone: string
  notify: boolean
  /** The window, or a template of «Шаблоны» it was opened with (Зп9). */
  templateSlug: string | null
  now: Date
}

/** «Создать» (Зп7, Зп9, Зп11, Зп15, Зп16, Зп25, Зп26). */
export async function createSchedule(
  db: PrismaClient,
  appEnv: AppEnv,
  input: ScheduleInput,
): Promise<ScheduleDetail> {
  const instructions = checkedInstructions(input.userId, input.instructions)
  checkTemplate(input.templateSlug, input.siteId)
  const workspaceId = await workspaceOf(db, appEnv, input)
  const row = await createScheduledTask(db, {
    userId: input.userId,
    workspaceId,
    siteId: input.siteId,
    name: input.name,
    instructions,
    effort: input.effort,
    triggers: input.triggers,
    timezone: input.timezone,
    notify: input.notify,
    createdVia: input.templateSlug === null ? 'manual' : 'template',
    templateSlug: input.templateSlug,
    now: input.now,
  })
  return readSchedule(db, { userId: input.userId, scheduleId: row.id })
}

export interface ScheduleChange {
  name?: string
  instructions?: string
  effort?: ReasoningEffort
  triggers?: ScheduleTrigger[]
  timezone?: string
  notify?: boolean
  /** Another project, or none (null). */
  siteId?: string | null
}

/** «Сохранить» (Зп7, Зп13): only what is given changes. */
export async function updateSchedule(
  db: PrismaClient,
  appEnv: AppEnv,
  input: { userId: string; scheduleId: string; change: ScheduleChange; now: Date },
): Promise<ScheduleDetail> {
  const { change, userId } = input
  const patch: ScheduledTaskPatch = {}
  if (change.name !== undefined) patch.name = change.name
  if (change.instructions !== undefined)
    patch.instructions = checkedInstructions(userId, change.instructions)
  if (change.effort !== undefined) patch.effort = change.effort
  if (change.triggers !== undefined) patch.triggers = change.triggers
  if (change.timezone !== undefined) patch.timezone = change.timezone
  if (change.notify !== undefined) patch.notify = change.notify
  if (change.siteId !== undefined) {
    const own = await db.scheduledTask.findFirst({
      where: { id: input.scheduleId, createdById: userId, deletedAt: null },
      select: { templateSlug: true },
    })
    if (own === null) throw scheduleNotFound()
    checkTemplate(own.templateSlug, change.siteId)
    patch.project = {
      siteId: change.siteId,
      workspaceId: await workspaceOf(db, appEnv, { userId, siteId: change.siteId }),
    }
  }
  await updateScheduledTask(db, { scheduleId: input.scheduleId, userId, patch, now: input.now })
  return readSchedule(db, { userId, scheduleId: input.scheduleId })
}

/** The switch (Зп5): pause, or resume from now within the 20 of the workspace. */
export async function setScheduleEnabled(
  db: PrismaClient,
  input: { userId: string; scheduleId: string; enabled: boolean; now: Date },
): Promise<ScheduleDetail> {
  await setScheduledTaskEnabled(db, input)
  return readSchedule(db, input)
}

/** «Удалить» (Зп23): the chats of its runs stay. */
export async function deleteSchedule(
  db: PrismaClient,
  input: { userId: string; scheduleId: string; now: Date },
): Promise<{ deleted: true }> {
  await deleteScheduledTask(db, input)
  return { deleted: true }
}

/**
 * «Запустить сейчас» (Зп24, §4.3): a run out of the schedule under the lock of the task — of a
 * paused one too —, then the same start as a run core hands over. Its chat is the answer. A refusal
 * is recorded on the run and told in the cabinet in words, without a notice: a refusal of
 * `createDialog` as that error says it, any other by its reason. A failure that may pass leaves no
 * run behind, as if nothing was pressed — only a run this press wrote, and only while it still
 * waits: a chat is bound to its run by the transaction that makes it, so a run with a chat stays,
 * and a run of an earlier press (the same minute, or one a stopped web left waiting) is its own.
 */
export async function runScheduleNow(
  db: PrismaClient,
  chat: ChatContext,
  input: { userId: string; scheduleId: string; now: Date },
): Promise<{ taskId: string }> {
  const { runId, created } = await insertManualRun(db, input)
  let started: Awaited<ReturnType<typeof startRun>>
  try {
    started = await startRun(db, chat, { runId, now: input.now })
  } catch (error) {
    if (created) await dropPendingRun(db, runId).catch(() => false)
    throw error
  }
  const { response, refusal } = started
  if (response.outcome === 'started') return { taskId: response.taskId }
  if (refusal !== undefined) throw refusal
  throw scheduleRunRefused(response.reason)
}

/** What «Стоимость» of the window says (Зп30). */
export interface ScheduleCostHint {
  /** `averageTaskCredits`: the average charge of a chat. */
  averageCredits: number
  /** Runs of the schedules in the next 7 days. */
  runsPerWeek: number
  /** About this many credits a week: the two above multiplied. */
  creditsPerWeek: number
  /** `plans.credits_per_week` of the tariff of the workspace; null — none bounds it. */
  weeklyLimit: number | null
  /** More than half the weekly limit: the window says it in the colour of a warning. */
  overHalf: boolean
}

/**
 * «Каждый запуск тратит кредиты, как обычный чат, — в среднем около 11. Так выйдет примерно N в
 * неделю; ваш недельный лимит — M.» (Зп30): N by the schedules of the window over the next 7 days,
 * M — of the tariff of the workspace the task would go to. Nothing is made: a user without a
 * personal workspace yet is told without a limit.
 */
export async function scheduleCostHint(
  db: PrismaClient,
  appEnv: AppEnv,
  input: { userId: string; siteId: string | null; triggers: unknown; timezone: string; now: Date },
): Promise<ScheduleCostHint> {
  const triggers = scheduleTriggerListSchema.safeParse(input.triggers)
  if (!triggers.success) throw badRequest('Invalid schedules of a scheduled task')
  const timezone = scheduleTimezoneSchema.safeParse(input.timezone)
  if (!timezone.success) throw badRequest('An unknown time zone')
  let workspaceId: string | null
  if (input.siteId === null) {
    workspaceId = (await findPersonalWorkspace(db, { userId: input.userId, appEnv }))?.id ?? null
  } else {
    const site = await db.site.findFirst({
      where: accessibleSite(input.userId, input.siteId),
      select: { workspaceId: true },
    })
    if (site === null) throw siteNotFound()
    workspaceId = site.workspaceId
  }
  const from = new Date(input.now.getTime() + 1)
  const runsPerWeek = dueCountBetween(
    triggers.data,
    timezone.data,
    from,
    new Date(input.now.getTime() + 7 * DAY_MS),
  )
  const weeklyLimit =
    workspaceId === null ? null : (await workspaceUsageTerms(db, workspaceId)).limits.week
  const creditsPerWeek = runsPerWeek * averageTaskCredits
  return {
    averageCredits: averageTaskCredits,
    runsPerWeek,
    creditsPerWeek,
    weeklyLimit,
    overHalf: weeklyLimit !== null && creditsPerWeek * 2 > weeklyLimit,
  }
}

/**
 * «Следующий запуск» of the window, from the server's clock (Зп7); null — only by hand, or the
 * single run is in the past (the window says «Это время уже прошло»).
 */
export function scheduleNextRun(input: {
  triggers: unknown
  timezone: string
  now: Date
}): Date | null {
  const triggers = scheduleTriggerListSchema.safeParse(input.triggers)
  if (!triggers.success) throw badRequest('Invalid schedules of a scheduled task')
  const timezone = scheduleTimezoneSchema.safeParse(input.timezone)
  if (!timezone.success) throw badRequest('An unknown time zone')
  return nextRunOf(triggers.data, timezone.data, input.now)
}

/** The zone of the client's browser (Зп12), remembered for their next task; the canonical name. */
export async function rememberTimezone(
  db: PrismaClient,
  input: { userId: string; timezone: string },
): Promise<{ timezone: string }> {
  return { timezone: await rememberUserTimezone(db, input.userId, input.timezone) }
}

/** The zone a new task of the user takes by default (Зп12): their browser's, else Moscow. */
export async function defaultTimezone(db: PrismaClient, userId: string): Promise<string> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { timezone: true } })
  return user?.timezone ?? DEFAULT_SCHEDULE_TIMEZONE
}

/**
 * How many tasks «Удалить проект» stops (Зп22): the window of the deletion names them. A project
 * the user cannot open answers as one that does not exist.
 */
export async function projectScheduleCount(
  db: PrismaClient,
  input: { userId: string; siteId: string },
): Promise<{ count: number }> {
  const site = await db.site.findFirst({
    where: accessibleSite(input.userId, input.siteId),
    select: { id: true },
  })
  if (site === null) throw siteNotFound()
  return { count: await countSiteSchedules(db, site.id) }
}
