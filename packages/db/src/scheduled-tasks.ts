import {
  badRequest,
  DEFAULT_SCHEDULE_TIMEZONE,
  DomainError,
  dueCountBetween,
  hasScheduleTemplatePlaceholder,
  hasVisibleText,
  isClientRefusalReason,
  latestDueOf,
  looksLikeSecret,
  nextRunOf,
  reasoningEffortSchema,
  resolveScheduleToolTriggers,
  SCHEDULE_QUEUE,
  SCHEDULE_START_JOB,
  scheduleChangeLimitReached,
  scheduleConfirmChanged,
  scheduleErrorOfIssues,
  scheduleForbidden,
  scheduleInPast,
  scheduleInstructionsSchema,
  scheduleLimitReached,
  scheduleLimits,
  scheduleNameSchema,
  scheduleNeedsClient,
  scheduleNotFound,
  scheduleProjectGone,
  scheduleRunBusy,
  scheduleStartDedupeKey,
  scheduleTemplatePlaceholder,
  scheduleTimezoneSchema,
  scheduleTriggerListSchema,
  scheduleTriggersInPast,
  scheduleTriggersSchema,
  type ReasoningEffort,
  type ScheduleChangeAction,
  type ScheduleCreateArguments,
  type ScheduleCreatedVia,
  type ScheduleDeleteArguments,
  type ScheduledRunReason,
  type ScheduledRunTrigger,
  type ScheduleLeftAction,
  type SchedulePausedReason,
  type ScheduleToolTrigger,
  projectNotFound,
  type ScheduleTrigger,
  type ScheduleUpdateArguments,
} from '@repo/domain'

import type {
  Prisma,
  PrismaClient,
  ScheduledTask,
  ScheduleReservation,
} from './generated/prisma/client.ts'
import { enqueueOutbox } from './outbox.ts'
import { chatAuthorManages } from './pages.ts'
import { uuidv7 } from './uuidv7.ts'

// Scheduled tasks (docs/plan/82-scheduled-tasks.md, §4.2): the client's — the window of the
// cabinet — and the agent's — reservations of a turn applied when it ended (Зп33). Every write of
// a task takes its row FOR UPDATE (Зп13); the 20 enabled tasks of a workspace are counted under the
// workspace's row FOR NO KEY UPDATE (Зп16), always taken before the task's. The tick of core takes
// the task's row alone, so it never waits on a workspace. Runs are written only under the task's
// row (Зп20), with a snapshot of its fields: a repeat of a start begins from them.
//
// A task may be of a project of its creator (docs/plan/84-projects.md, ПР19): its row is taken FOR
// KEY SHARE after the task's, as «В архив» and «Удалить» of the project take the tasks first and the
// project FOR UPDATE, so a task is never turned on in a project being put away, and its pause
// (`project_gone`) is written in their transaction.

type Db = Pick<PrismaClient, '$transaction'>
type Tx = Prisma.TransactionClient

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** Statuses of a chat that still works: a run whose chat is in one of them is going on (Зп14). */
const workingChatStatuses = ['queued', 'preparing', 'running'] as const

/** Outcomes of a reservation of the agent once closed. */
export const scheduleReservationOutcomes = ['done', 'refused', 'failed'] as const
export type ScheduleReservationOutcome = (typeof scheduleReservationOutcomes)[number]

// ———————————————————————————————————————— checks of the fields

/** The fields of a task its creator — or the agent of their chat — sets (Зп7, Зп31). */
export interface ScheduleFields {
  name: string
  instructions: string
  effort: ReasoningEffort
  triggers: ScheduleTrigger[]
  timezone: string
  notify: boolean
}

// The refusals of the words of a request (Зп26): the codes the cabinet already tells in the
// client's words (packages/trpc/src/errors.ts); the text is never repeated in the message.
const textEmpty = () =>
  new DomainError('TASK_TEXT_EMPTY', 'The instructions have no visible characters', 400)
const textTooLong = () =>
  new DomainError('TASK_TEXT_TOO_LONG', 'The instructions are longer than a request', 400)
const textHasSecret = () =>
  new DomainError('TASK_TEXT_HAS_SECRET', 'The task looks like it holds a password or a key', 400)
const textInvalid = () =>
  new DomainError(
    'TASK_TEXT_INVALID',
    'The instructions have characters a request cannot hold',
    400,
  )

function checkedName(name: string): string {
  const parsed = scheduleNameSchema.safeParse(name)
  if (!parsed.success)
    throw badRequest('The name of a scheduled task is one line of 1–80 characters')
  if (looksLikeSecret(parsed.data)) throw textHasSecret()
  return parsed.data
}

function checkedInstructions(text: string): string {
  const trimmed = text.trim()
  if (!hasVisibleText(trimmed)) throw textEmpty()
  if (trimmed.length > scheduleLimits.instructionsMax) throw textTooLong()
  if (looksLikeSecret(trimmed)) throw textHasSecret()
  const parsed = scheduleInstructionsSchema.safeParse(trimmed)
  if (!parsed.success) throw textInvalid()
  // A place of a template left as it was, `[впишите …]`: no task is saved with it, the client's
  // or the agent's (Зп59).
  if (hasScheduleTemplatePlaceholder(parsed.data)) throw scheduleTemplatePlaceholder()
  return parsed.data
}

function checkedEffort(effort: string): ReasoningEffort {
  const parsed = reasoningEffortSchema.safeParse(effort)
  if (!parsed.success) throw badRequest('«Размышление» is low, high or max')
  return parsed.data
}

/** 0–5 schedules not closer than an hour (Зп11): SCHEDULE_TOO_OFTEN, or the shape refused. */
function checkedTriggers(triggers: unknown): ScheduleTrigger[] {
  const parsed = scheduleTriggersSchema.safeParse(triggers)
  if (!parsed.success)
    throw (
      scheduleErrorOfIssues(parsed.error.issues) ??
      badRequest('The schedules of a task do not fit: at most five, of the window')
    )
  return parsed.data
}

/** A zone of the IANA database, as Intl names it (Зп12). */
function checkedTimezone(timezone: string): string {
  const parsed = scheduleTimezoneSchema.safeParse(timezone)
  if (!parsed.success) throw badRequest('An unknown time zone')
  return parsed.data
}

/** The schedules of a stored task. A row no writer would have written is refused, never guessed. */
export function scheduleTriggersOf(row: { triggers: Prisma.JsonValue }): ScheduleTrigger[] {
  const parsed = scheduleTriggerListSchema.safeParse(row.triggers)
  if (!parsed.success) throw badRequest('The schedules of a scheduled task cannot be read')
  return parsed.data
}

/** The fields of a stored task. */
export function scheduleFieldsOf(row: ScheduledTask): ScheduleFields {
  return {
    name: row.name,
    instructions: row.instructions,
    effort: checkedEffort(row.effort),
    triggers: scheduleTriggersOf(row),
    timezone: row.timezone,
    notify: row.notify,
  }
}

const sameTriggers = (a: readonly ScheduleTrigger[], b: readonly ScheduleTrigger[]) =>
  JSON.stringify(a) === JSON.stringify(b)

/**
 * The next due moment of schedules saved now (Зп13, Зп15): from now, always ahead; null — only by
 * hand. A single run in the past is not saved — `SCHEDULE_IN_PAST` — even when another schedule
 * runs on. `spent`: the single runs the task had whose moment has passed — they came and went
 * (ran, or were skipped or missed) and are no reason to refuse the others: a task with «Один раз»
 * beside «Ежедневно» is turned on again or changed after it ran (Зп15); a past single run the
 * change adds, or moves, still is. `recentSince`: the moment the
 * agent asked for it (Зп15) — a single run that was ahead then and is due now, not older than the
 * catch-up limit, is kept and becomes the due moment the next tick runs at once.
 */
function nextRunFor(
  fields: ScheduleFields,
  now: Date,
  recentSince?: Date,
  spent: readonly ScheduleTrigger[] = [],
): Date | null {
  const { triggers, timezone } = fields
  if (triggers.length === 0) return null
  const next = nextRunOf(triggers, timezone, now)
  const judged = triggers.filter(
    (trigger) =>
      trigger.kind !== 'once' || !spent.some((before) => sameTriggers([before], [trigger])),
  )
  if (!scheduleTriggersInPast(judged, timezone, now)) {
    if (next === null) throw scheduleInPast()
    return next
  }
  if (recentSince === undefined) throw scheduleInPast()
  const since = Math.max(
    recentSince.getTime(),
    now.getTime() - scheduleLimits.catchUpHours * HOUR_MS,
  )
  let earliest: Date | null = null
  for (const trigger of judged) {
    if (trigger.kind !== 'once') continue
    if (!scheduleTriggersInPast([trigger], timezone, now)) continue
    const at = latestDueOf([trigger], timezone, new Date(since), now)
    // Due before the agent asked, or older than the limit: the client would never have it.
    if (at === null) throw scheduleInPast()
    if (earliest === null || at < earliest) earliest = at
  }
  return earliest ?? next
}

/** The fields given, checked and in their stored form. */
function checkedFields(fields: ScheduleFields): ScheduleFields {
  return {
    name: checkedName(fields.name),
    instructions: checkedInstructions(fields.instructions),
    effort: checkedEffort(fields.effort),
    triggers: checkedTriggers(fields.triggers),
    timezone: checkedTimezone(fields.timezone),
    notify: fields.notify,
  }
}

// ———————————————————————————————————————— locks and rights

/** The workspace's row for its count of enabled tasks (Зп16); false — no such workspace. */
async function lockWorkspace(tx: Tx, workspaceId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM workspaces WHERE id = ${workspaceId}::uuid FOR NO KEY UPDATE`
  return rows.length > 0
}

/** A task under its row lock; null — none. */
async function lockSchedule(tx: Tx, scheduleId: string): Promise<ScheduledTask | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM scheduled_tasks WHERE id = ${scheduleId}::uuid FOR UPDATE`
  if (rows.length === 0) return null
  return tx.scheduledTask.findUnique({ where: { id: scheduleId } })
}

/** Whether a user is now an owner or an administrator of a workspace (Зп25). */
async function userManages(
  tx: Pick<Tx, 'member'>,
  userId: string,
  workspaceId: string,
): Promise<boolean> {
  const member = await tx.member.findUnique({
    where: { workspaceId_userId: { workspaceId, userId } },
    select: { role: true },
  })
  return member?.role === 'owner' || member?.role === 'admin'
}

/**
 * The project of a task (ПР19): its creator's, of the task's workspace, out of «Архив» and the
 * trash. Its row FOR KEY SHARE: «В архив» and «Удалить» hold it FOR UPDATE, so the check waits for
 * them and reads what they wrote. PROJECT_NOT_FOUND for another's or none, SCHEDULE_PROJECT_GONE
 * for one put away.
 */
async function checkProject(
  tx: Tx,
  projectId: string | null,
  owner: { userId: string; workspaceId: string },
): Promise<void> {
  if (projectId === null) return
  const [project] = await tx.$queryRaw<
    {
      workspace_id: string
      created_by_id: string
      archived_at: Date | null
      deleted_at: Date | null
    }[]
  >`
    SELECT workspace_id, created_by_id, archived_at, deleted_at FROM projects
    WHERE id = ${projectId}::uuid FOR KEY SHARE`
  if (
    !project ||
    project.created_by_id !== owner.userId ||
    project.workspace_id !== owner.workspaceId
  )
    throw projectNotFound()
  if (project.deleted_at !== null || project.archived_at !== null) throw scheduleProjectGone()
}

/** Whether a project has a repository: the agent's tasks of its chats wait for the client (ПР19). */
async function projectHasRepository(tx: Tx, projectId: string | null): Promise<boolean> {
  if (projectId === null) return false
  return (await tx.projectRepository.count({ where: { projectId } })) > 0
}

/**
 * A task of its creator, alive; another's or a deleted one is never told apart (Зп25, Зп44). The
 * creator manages their personal workspace, where every task is: the check stays the one of the
 * pages (`chatAuthorManages`), with no reason of its own.
 */
async function ownSchedule(tx: Tx, scheduleId: string, userId: string): Promise<ScheduledTask> {
  const task = await lockSchedule(tx, scheduleId)
  if (!task || task.deletedAt !== null || task.createdById !== userId) throw scheduleNotFound()
  if (!(await userManages(tx, userId, task.workspaceId))) throw scheduleForbidden()
  return task
}

/** Enabled tasks of a workspace, the one changed aside. */
function enabledTasks(tx: Tx, workspaceId: string, except?: string): Promise<number> {
  return tx.scheduledTask.count({
    where: {
      workspaceId,
      enabled: true,
      deletedAt: null,
      ...(except !== undefined ? { id: { not: except } } : {}),
    },
  })
}

/** Open reservations of the agent that would enable a task — new ones or resumed (Зп33). */
function enablingReservations(tx: Tx, workspaceId: string, except?: string): Promise<number> {
  return tx.scheduleReservation.count({
    where: {
      workspaceId,
      outcome: null,
      payload: { path: ['enables'], equals: true },
      ...(except !== undefined ? { id: { not: except } } : {}),
    },
  })
}

async function checkRoom(tx: Tx, workspaceId: string, except?: string): Promise<void> {
  if ((await enabledTasks(tx, workspaceId, except)) >= scheduleLimits.activePerWorkspace)
    throw scheduleLimitReached()
}

// ———————————————————————————————————————— the client's tasks

export interface ScheduledTaskInput {
  /** The creator: an owner or an administrator of the workspace (Зп25). */
  userId: string
  /** The creator's personal workspace (Зп44). */
  workspaceId: string
  /** A project of the creator in that workspace (ПР19); null or absent — none. */
  projectId?: string | null
  name: string
  instructions: string
  effort: ReasoningEffort
  triggers: readonly ScheduleTrigger[]
  timezone: string
  notify?: boolean
  /** Created paused; by default enabled. */
  enabled?: boolean
  createdVia: ScheduleCreatedVia
  templateSlug?: string | null
  /** The chat it was set up in (Зп33): only with `chat`. */
  sourceTaskId?: string | null
  now: Date
}

/** The data of a new task, checked (Зп11–Зп16, Зп26); the workspace is locked by the caller. */
async function newTaskData(
  tx: Tx,
  input: Omit<ScheduledTaskInput, 'now' | 'triggers'> & { triggers: unknown },
  now: Date,
  recentSince?: Date,
): Promise<Prisma.ScheduledTaskUncheckedCreateInput> {
  const fields = checkedFields({
    name: input.name,
    instructions: input.instructions,
    effort: input.effort,
    triggers: input.triggers as ScheduleTrigger[],
    timezone: input.timezone,
    notify: input.notify ?? true,
  })
  const enabled = input.enabled ?? true
  const projectId = input.projectId ?? null
  await checkProject(tx, projectId, input)
  const nextRunAt = nextRunFor(fields, now, recentSince)
  if (enabled) await checkRoom(tx, input.workspaceId)
  return {
    id: uuidv7(),
    workspaceId: input.workspaceId,
    createdById: input.userId,
    projectId,
    name: fields.name,
    instructions: fields.instructions,
    effort: fields.effort,
    triggers: fields.triggers as Prisma.InputJsonValue,
    timezone: fields.timezone,
    notify: fields.notify,
    enabled,
    nextRunAt: enabled ? nextRunAt : null,
    createdVia: input.createdVia,
    templateSlug: input.createdVia === 'template' ? (input.templateSlug ?? null) : null,
    sourceTaskId: input.createdVia === 'chat' ? (input.sourceTaskId ?? null) : null,
  }
}

/**
 * «Создать» of the window (Зп7, Зп9): the creator manages the workspace, the project is theirs and
 * neither in «Архив» nor in the trash (ПР19), the fields pass the rules of the domain, a single run
 * is ahead, and an enabled task fits the 20 of the workspace — counted under its row.
 */
export async function createScheduledTask(
  db: Db,
  input: ScheduledTaskInput,
): Promise<ScheduledTask> {
  return db.$transaction(async (tx) => {
    if (!(await lockWorkspace(tx, input.workspaceId))) throw scheduleForbidden()
    if (!(await userManages(tx, input.userId, input.workspaceId))) throw scheduleForbidden()
    const data = await newTaskData(tx, input, input.now)
    return tx.scheduledTask.create({ data })
  })
}

/** What a change of a task sets; a field left out stays. */
export interface ScheduledTaskPatch {
  name?: string
  instructions?: string
  effort?: ReasoningEffort
  triggers?: readonly ScheduleTrigger[]
  timezone?: string
  notify?: boolean
  /** Another project of the creator, or none (ПР19); left out — as it is. */
  projectId?: string | null
  /** Paused (false) or resumed (true); left out — as it is. */
  enabled?: boolean
}

/** What a change makes of a task (Зп13, Зп15): its fields, its state and its due moment. */
interface PlannedChange {
  fields: ScheduleFields
  enabled: boolean
  /** It turns the task on: counted against the 20 (Зп16). */
  enabling: boolean
  pausing: boolean
  nextRunAt: Date | null
}

/**
 * The rules of a change, with no reads (Зп13, Зп15): only the fields given are checked; the due
 * moment moves only when the schedule, the zone or the state changes; a task that completed takes
 * a new schedule as a wish to run again.
 */
function planChange(
  task: ScheduledTask,
  patch: ScheduledTaskPatch,
  now: Date,
  recentSince?: Date,
): PlannedChange {
  const current = scheduleFieldsOf(task)
  const triggers = patch.triggers !== undefined ? checkedTriggers(patch.triggers) : current.triggers
  const timezone = patch.timezone !== undefined ? checkedTimezone(patch.timezone) : current.timezone
  const fields: ScheduleFields = {
    name: patch.name !== undefined ? checkedName(patch.name) : current.name,
    instructions:
      patch.instructions !== undefined
        ? checkedInstructions(patch.instructions)
        : current.instructions,
    effort: patch.effort !== undefined ? checkedEffort(patch.effort) : current.effort,
    triggers,
    timezone,
    notify: patch.notify ?? current.notify,
  }
  const rescheduled = !sameTriggers(triggers, current.triggers) || timezone !== current.timezone
  const enabled =
    patch.enabled ??
    (task.pausedReason === 'completed' && patch.triggers !== undefined && rescheduled
      ? true
      : task.enabled)
  const enabling = enabled && !task.enabled
  let nextRunAt = task.nextRunAt
  // The single runs of the task as it was whose moment, in its zone then, has passed are spent:
  // kept beside the schedules that run on, they never refuse a resume or a change (Зп15).
  const spent = current.triggers.filter(
    (trigger) =>
      trigger.kind === 'once' && scheduleTriggersInPast([trigger], current.timezone, now),
  )
  if (!enabled) nextRunAt = null
  else if (rescheduled || enabling) nextRunAt = nextRunFor(fields, now, recentSince, spent)
  return { fields, enabled, enabling, pausing: task.enabled && !enabled, nextRunAt }
}

/**
 * A change of a locked task, in the caller's transaction with its workspace locked (Зп13–Зп16): a
 * task enabled fits the 20 there.
 */
async function changeInTx(
  tx: Tx,
  task: ScheduledTask,
  patch: ScheduledTaskPatch,
  now: Date,
  recentSince?: Date,
  /** A task off after the change stops for this reason: the agent's change waits for the client. */
  pauseAs?: 'unconfirmed',
): Promise<{ row: ScheduledTask; action: Exclude<ScheduleChangeAction, 'created' | 'deleted'> }> {
  const { fields, enabled, enabling, pausing, nextRunAt } = planChange(
    task,
    patch,
    now,
    recentSince,
  )
  const projectId = patch.projectId !== undefined ? patch.projectId : task.projectId
  const moved = projectId !== task.projectId
  // A task moved or turned on goes into a live project of its creator (ПР19).
  if (moved || (enabled && enabling))
    await checkProject(tx, projectId, { userId: task.createdById, workspaceId: task.workspaceId })
  if (enabling) await checkRoom(tx, task.workspaceId, task.id)
  const stopped = !enabled && pauseAs !== undefined
  const row = await tx.scheduledTask.update({
    where: { id: task.id },
    data: {
      name: fields.name,
      instructions: fields.instructions,
      effort: fields.effort,
      triggers: fields.triggers as Prisma.InputJsonValue,
      timezone: fields.timezone,
      notify: fields.notify,
      projectId,
      enabled,
      nextRunAt,
      // A task paused by the client has no reason of its own; one resumed is a fresh start. A task
      // of a project put away, moved to another or to none, is no longer stopped by it: off, it is
      // a task the client keeps paused.
      ...(stopped
        ? { pausedReason: pauseAs }
        : enabled || pausing || (moved && task.pausedReason === 'project_gone')
          ? { pausedReason: null }
          : {}),
      ...(enabling ? { refusalStreak: 0, lastRefusalReason: null } : {}),
    },
  })
  return { row, action: enabling ? 'resumed' : pausing ? 'paused' : 'updated' }
}

/**
 * «Сохранить» of the window (Зп7): by its creator while they manage its workspace. The name, the
 * words, «Размышление» and the notices leave the due moment as it was (Зп13).
 */
export async function updateScheduledTask(
  db: Db,
  input: { scheduleId: string; userId: string; patch: ScheduledTaskPatch; now: Date },
): Promise<ScheduledTask> {
  return db.$transaction(async (tx) => {
    const before = await tx.scheduledTask.findUnique({
      where: { id: input.scheduleId },
      select: { workspaceId: true },
    })
    if (!before || !(await lockWorkspace(tx, before.workspaceId))) throw scheduleNotFound()
    const task = await ownSchedule(tx, input.scheduleId, input.userId)
    return (await changeInTx(tx, task, input.patch, input.now)).row
  })
}

/** The switch of a task (Зп5): pause, or resume from now — within the 20 of the workspace. */
export async function setScheduledTaskEnabled(
  db: Db,
  input: { scheduleId: string; userId: string; enabled: boolean; now: Date },
): Promise<ScheduledTask> {
  return db.$transaction(async (tx) => {
    const before = await tx.scheduledTask.findUnique({
      where: { id: input.scheduleId },
      select: { workspaceId: true },
    })
    if (!before || !(await lockWorkspace(tx, before.workspaceId))) throw scheduleNotFound()
    const task = await ownSchedule(tx, input.scheduleId, input.userId)
    if (task.enabled === input.enabled) return task
    return (await changeInTx(tx, task, { enabled: input.enabled }, input.now)).row
  })
}

/**
 * «Включить задачу» of the card in the chat (ПР19): a task the agent set up or changed in a chat of
 * a project with a repository is turned on by its creator, only while it waits for them and only
 * when `signed` says the card showed exactly the task as it is now — its words, its schedule and
 * its last change (the card's HMAC, checked under the task's row). SCHEDULE_CONFIRM_CHANGED
 * otherwise; within the 20 of the workspace and with its project live.
 */
export async function confirmScheduledTask(
  db: Db,
  input: {
    scheduleId: string
    userId: string
    signed: (task: ScheduledTask) => boolean
    now: Date
  },
): Promise<ScheduledTask> {
  return db.$transaction(async (tx) => {
    const before = await tx.scheduledTask.findUnique({
      where: { id: input.scheduleId },
      select: { workspaceId: true },
    })
    if (!before || !(await lockWorkspace(tx, before.workspaceId))) throw scheduleNotFound()
    const task = await ownSchedule(tx, input.scheduleId, input.userId)
    if (task.pausedReason !== 'unconfirmed' || !input.signed(task)) throw scheduleConfirmChanged()
    return (await changeInTx(tx, task, { enabled: true }, input.now)).row
  })
}

/** «Удалить» (Зп23): gone from the list, off; its runs and their chats stay. */
export async function deleteScheduledTask(
  db: Db,
  input: { scheduleId: string; userId: string; now: Date },
): Promise<ScheduledTask> {
  return db.$transaction(async (tx) => {
    const task = await ownSchedule(tx, input.scheduleId, input.userId)
    return tx.scheduledTask.update({
      where: { id: task.id },
      data: { deletedAt: input.now, enabled: false, nextRunAt: null },
    })
  })
}

/** The project of a task as the list shows it (ПР19): its name, and whether it was put away. */
const projectOfList = {
  select: { id: true, name: true, archivedAt: true, deletedAt: true },
} as const

/**
 * A run as the list and the page show it: what its state is told by, not the copy of the
 * instructions it started with.
 */
const runOfList = {
  orderBy: [{ createdAt: 'desc' }, { dueAt: 'desc' }],
  select: {
    id: true,
    dueAt: true,
    trigger: true,
    status: true,
    reason: true,
    missedCount: true,
    missedUntil: true,
    taskId: true,
    createdAt: true,
    startedAt: true,
    task: {
      select: {
        id: true,
        status: true,
        title: true,
        deletedAt: true,
      },
    },
  },
} satisfies Prisma.ScheduledTask$runsArgs

/**
 * «Ваши» (Зп25): the tasks a user created, not deleted, in workspaces they are still a member of,
 * each with its latest run and its project; `workspaceId` — of one workspace (`schedule_list`,
 * Зп54); `projectId` — of one project, null — without one (the column of a project and the tools of
 * a chat, ПР19).
 */
export function listScheduledTasks(
  db: Pick<PrismaClient, 'scheduledTask'>,
  input: { userId: string; workspaceId?: string; projectId?: string | null },
) {
  return db.scheduledTask.findMany({
    where: {
      createdById: input.userId,
      deletedAt: null,
      workspace: { members: { some: { userId: input.userId } } },
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { project: projectOfList, runs: { ...runOfList, take: 1 } },
  })
}

/** A task of its creator with its last 50 runs (Зп6); another's or a deleted one — not found. */
export async function readScheduledTask(
  db: Pick<PrismaClient, 'scheduledTask'>,
  input: { scheduleId: string; userId: string },
) {
  const task = await db.scheduledTask.findFirst({
    where: {
      id: input.scheduleId,
      createdById: input.userId,
      deletedAt: null,
      workspace: { members: { some: { userId: input.userId } } },
    },
    include: { project: projectOfList, runs: { ...runOfList, take: 50 } },
  })
  if (!task) throw scheduleNotFound()
  return task
}

/** The zone of the client's browser, remembered for their next task (Зп12); the canonical name. */
export async function rememberUserTimezone(
  db: Pick<PrismaClient, 'user'>,
  userId: string,
  timezone: string,
): Promise<string> {
  const canonical = checkedTimezone(timezone)
  await db.user.updateMany({
    where: { id: userId, OR: [{ timezone: null }, { timezone: { not: canonical } }] },
    data: { timezone: canonical },
  })
  return canonical
}

// ———————————————————————————————————————— the project (ПР19)

/** What «В архив» and «Удалить» of a project stop: its tasks not deleted, not stopped already. */
const stoppedByProjectGone = (projectId: string): Prisma.ScheduledTaskWhereInput => ({
  projectId,
  deletedAt: null,
  OR: [
    { pausedReason: null },
    { pausedReason: { notIn: ['completed', 'project_gone', 'unconfirmed'] } },
  ],
})

/**
 * The tasks of a project, locked before its row by «В архив», «Удалить» and the purge: a change of a
 * task takes the task's row and then the project's (`checkProject`), and a start of a run takes the
 * task's row and then makes its chat, which takes the project's — so these take the tasks first
 * and the two never wait on each other in a circle.
 */
export async function lockProjectSchedules(tx: Tx, projectId: string): Promise<void> {
  await tx.$queryRaw`
    SELECT id FROM scheduled_tasks WHERE project_id = ${projectId}::uuid AND deleted_at IS NULL
    ORDER BY id FOR UPDATE`
}

/**
 * The tasks of a project put into «Архив» or the trash stop — `project_gone`, without a notice — in
 * the transaction that puts it away, after `lockProjectSchedules` and the project's row FOR
 * UPDATE. «Из архива» and «Вернуть» turn none on again: the client does. Returns how many.
 */
export async function pauseProjectSchedules(tx: Tx, projectId: string): Promise<number> {
  await lockProjectSchedules(tx, projectId)
  const paused = await tx.scheduledTask.updateMany({
    where: stoppedByProjectGone(projectId),
    data: { enabled: false, nextRunAt: null, pausedReason: 'project_gone' },
  })
  return paused.count
}

/**
 * A repository attached to a project (ревью, безопасность 5; ПР19): the tasks the agent set up in
 * its chats stop and wait for «Включить задачу» — they would run unattended with the private code
 * from now on, and the client never said these words in a project with a repository. Locks the
 * tasks before the project's row, as `lockProjectSchedules` says. Returns how many.
 */
export async function pauseAgentSchedulesForRepository(tx: Tx, projectId: string): Promise<number> {
  await lockProjectSchedules(tx, projectId)
  const paused = await tx.scheduledTask.updateMany({
    where: { projectId, deletedAt: null, createdVia: 'chat', enabled: true },
    data: { enabled: false, nextRunAt: null, pausedReason: 'unconfirmed' },
  })
  return paused.count
}

/**
 * The purge of a project (ПР20): its tasks are deleted, as «Удалить» of each would; the runs keep
 * their rows and lose the project with it (ON DELETE SET NULL). In the purge's transaction.
 */
export async function deleteProjectSchedules(
  tx: Tx,
  projectId: string,
  now: Date,
): Promise<number> {
  await lockProjectSchedules(tx, projectId)
  const deleted = await tx.scheduledTask.updateMany({
    where: { projectId, deletedAt: null },
    data: { deletedAt: now, enabled: false, nextRunAt: null },
  })
  return deleted.count
}

/**
 * The second line after «В архив» and «Удалить» (core's sweep of the trash): projects put away
 * whose tasks still run. None should be — the pause is written with them —, so it is cheap.
 */
export async function projectsWithRunningSchedules(
  db: Pick<PrismaClient, '$queryRaw'>,
  limit: number,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT DISTINCT p.id FROM projects p
    JOIN scheduled_tasks s ON s.project_id = p.id
    WHERE (p.deleted_at IS NOT NULL OR p.archived_at IS NOT NULL)
      AND s.deleted_at IS NULL AND s.enabled
    LIMIT ${limit}`
  return rows.map((row) => row.id)
}

/**
 * Stops the tasks of a project the sweep found put away, under the order of «В архив»: its tasks,
 * then its row FOR SHARE; a project back in the meantime keeps them. Returns how many stopped.
 */
export async function pauseSchedulesOfGoneProject(db: Db, projectId: string): Promise<number> {
  return db.$transaction(async (tx) => {
    await lockProjectSchedules(tx, projectId)
    const [project] = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM projects
      WHERE id = ${projectId}::uuid AND (deleted_at IS NOT NULL OR archived_at IS NOT NULL)
      FOR SHARE`
    if (!project) return 0
    return pauseProjectSchedules(tx, projectId)
  })
}

/**
 * A task stops by itself (Зп21, Зп22): the gate of a chat refused its first pass (`not_accepted`).
 * A task the client paused takes the reason as well; one stopped for another reason keeps its own.
 * Returns whether it stopped now.
 */
export async function pauseSchedule(
  tx: Tx,
  scheduleId: string,
  reason: Exclude<SchedulePausedReason, 'completed' | 'unconfirmed'>,
): Promise<boolean> {
  const task = await lockSchedule(tx, scheduleId)
  if (!task || task.deletedAt !== null) return false
  if (!task.enabled && task.pausedReason !== null) return false
  await tx.scheduledTask.update({
    where: { id: scheduleId },
    data: { enabled: false, nextRunAt: null, pausedReason: reason },
  })
  return true
}

// ———————————————————————————————————————— runs

/** The fields of a task a run takes with it (Зп20). */
const snapshotOf = (task: ScheduledTask) => ({
  scheduledTaskId: task.id,
  // Its chat starts in the project of the moment the run was written (ПР19).
  projectId: task.projectId,
  name: task.name,
  instructions: task.instructions,
  effort: task.effort,
})

/** A run of a task that goes on, as `runGoingOn` finds it. */
interface RunGoingOn {
  id: string
  trigger: string
  status: string
}

/**
 * The run of the task that goes on (Зп14, Зп24): one that waits for web, or one whose chat works
 * while it still goes without its client (Зп27). A chat of a run the client has taken over with
 * their own words is an ordinary chat of theirs — working in it holds the schedule up no more.
 * null — none goes on.
 */
async function runGoingOn(tx: Tx, scheduleId: string): Promise<RunGoingOn | null> {
  const pending = await tx.scheduledRun.findFirst({
    where: { scheduledTaskId: scheduleId, status: 'pending' },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, trigger: true, status: true },
  })
  if (pending) return pending
  const working = await tx.scheduledRun.findMany({
    where: {
      scheduledTaskId: scheduleId,
      status: 'started',
      task: { status: { in: [...workingChatStatuses] } },
    },
    select: { id: true, trigger: true, status: true, taskId: true },
  })
  for (const run of working)
    if (run.taskId !== null && (await onlyFirstRequest(tx, run.taskId, undefined))) return run
  return null
}

/** Writes a run unless one of the same moment and kind is there; whether it was written. */
async function insertRun(
  tx: Tx,
  data: Prisma.ScheduledRunCreateManyInput & { id: string },
): Promise<boolean> {
  const { count } = await tx.scheduledRun.createMany({ data: [data], skipDuplicates: true })
  return count === 1
}

/** What a claim of a due task did. */
export interface ScheduleClaim {
  /** The last moment due: the one that runs, or the latest one missed. */
  dueAt: Date
  /** The run handed to web by `schedule.start`; null — nothing starts. */
  startRunId: string | null
  /** «Пропущено» — one row of the earlier due moments, or of all when the last is too old. */
  missedRunId: string | null
  missedCount: number
  /** «Пропущено: предыдущий запуск ещё идёт» (Зп14). */
  busyRunId: string | null
  nextRunAt: Date | null
  /** No due moment is left: the task is off, `completed` (Зп15). */
  completed: boolean
}

/**
 * The tick's claim of one task (Зп14, Зп15, Зп19, Зп20), in the caller's transaction: under the
 * task's row — skipped when another holds it — the due moment is read again. The task runs once,
 * for the last moment due; earlier ones are one row «Пропущено», and a moment older than the
 * catch-up limit is not run. While a run of the task goes on, the moment is skipped — but the last
 * moment of a task, «Один раз», stays due until that run is over (or the limit passes). A run takes
 * a snapshot of the task and its outbox event `schedule.start`; the due moment moves on from now,
 * and a task with none left completes. Null — nothing was due.
 */
export async function claimDueSchedule(
  tx: Tx,
  scheduleId: string,
  now: Date,
): Promise<ScheduleClaim | null> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM scheduled_tasks WHERE id = ${scheduleId}::uuid FOR UPDATE SKIP LOCKED`
  if (rows.length === 0) return null
  const task = await tx.scheduledTask.findUnique({ where: { id: scheduleId } })
  if (
    !task ||
    task.deletedAt !== null ||
    !task.enabled ||
    task.nextRunAt === null ||
    task.nextRunAt > now
  )
    return null
  const triggers = scheduleTriggersOf(task)
  const from = task.nextRunAt
  const due = latestDueOf(triggers, task.timezone, from, now) ?? from
  // Moments in [from, due): the latest runs, the ones before it the platform missed.
  const earlier = Math.max(0, dueCountBetween(triggers, task.timezone, from, due) - 1)
  const tooLate = now.getTime() - due.getTime() > scheduleLimits.catchUpHours * HOUR_MS
  const missedCount = tooLate ? earlier + 1 : earlier
  const claim: ScheduleClaim = {
    dueAt: due,
    startRunId: null,
    missedRunId: null,
    missedCount,
    busyRunId: null,
    nextRunAt: null,
    completed: false,
  }
  const snapshot = snapshotOf(task)
  if (missedCount > 0) {
    const id = uuidv7()
    // The end of the gap (Зп6, «Пропущены запуски с … по …»): `due` itself when it is missed too,
    // otherwise the latest moment before it — the schedule may change before the row is read.
    const missedUntil = tooLate
      ? due
      : (latestDueOf(triggers, task.timezone, from, new Date(due.getTime() - 1)) ?? from)
    const written = await insertRun(tx, {
      id,
      ...snapshot,
      dueAt: from,
      trigger: 'schedule',
      status: 'skipped',
      reason: 'missed',
      missedCount,
      missedUntil,
    })
    if (written) claim.missedRunId = id
  }
  // From now: the due moment is never after it.
  let nextRunAt = nextRunOf(triggers, task.timezone, now)
  if (!tooLate) {
    const id = uuidv7()
    if ((await runGoingOn(tx, task.id)) !== null) {
      if (nextRunAt === null) {
        // The last moment of the task — «Один раз» — is never thrown away for a run that goes on:
        // it stays due and runs once that chat is idle, or is missed past the catch-up limit.
        nextRunAt = due
      } else {
        const written = await insertRun(tx, {
          id,
          ...snapshot,
          dueAt: due,
          trigger: 'schedule',
          status: 'skipped',
          reason: 'previous_running',
        })
        if (written) claim.busyRunId = id
      }
    } else if (
      await insertRun(tx, { id, ...snapshot, dueAt: due, trigger: 'schedule', status: 'pending' })
    ) {
      claim.startRunId = id
      await enqueueOutbox(tx, {
        topic: SCHEDULE_QUEUE,
        type: SCHEDULE_START_JOB,
        payload: { runId: id },
        dedupeKey: scheduleStartDedupeKey({ runId: id }),
      })
    }
  }
  claim.nextRunAt = nextRunAt
  claim.completed = claim.nextRunAt === null
  await tx.scheduledTask.update({
    where: { id: task.id },
    data: {
      nextRunAt: claim.nextRunAt,
      ...(claim.startRunId !== null ? { lastRunAt: due } : {}),
      ...(claim.completed ? { enabled: false, pausedReason: 'completed' } : {}),
    },
  })
  return claim
}

/**
 * The tasks due by now, the earliest first: the tick claims each in its own transaction. `skip` —
 * the ones this tick has read already: a task that stays due (another tick holds it, it threw, its
 * last moment waits for a run that goes on) never hides the ones after it.
 */
export async function dueScheduleIds(
  db: Pick<PrismaClient, 'scheduledTask'>,
  now: Date,
  limit = 100,
  skip: readonly string[] = [],
): Promise<string[]> {
  const rows = await db.scheduledTask.findMany({
    where: {
      enabled: true,
      deletedAt: null,
      nextRunAt: { lte: now },
      ...(skip.length > 0 ? { id: { notIn: [...skip] } } : {}),
    },
    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true },
  })
  return rows.map((row) => row.id)
}

/**
 * Runs web never answered, older than `olderThan`: the tick closes them, «сбой платформы» (Зп21).
 * `trigger` — of one kind only: a run of «Запустить сейчас» has no delivery of core to wait for,
 * so the sweep of chats closes it much sooner (`scheduleLimits.manualPendingSweepMinutes`).
 */
export function stalePendingRuns(
  db: Pick<PrismaClient, 'scheduledRun'>,
  olderThan: Date,
  limit = 100,
  trigger?: ScheduledRunTrigger,
) {
  return db.scheduledRun.findMany({
    where: {
      status: 'pending',
      createdAt: { lt: olderThan },
      ...(trigger !== undefined ? { trigger } : {}),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, scheduledTaskId: true, trigger: true, dueAt: true, attempts: true },
  })
}

/**
 * «Запустить сейчас» (Зп24): a run out of the schedule, written under the task's row by its
 * creator while they manage the workspace — of a paused task as well. Its moment is the minute,
 * so a second press of the same minute is the same run (`created: false`); a run of «Запустить
 * сейчас» that still waits — the web that wrote it stopped before it answered — is taken up again
 * (`created: false`): its chat is derived from it, so a start in flight is joined, never doubled;
 * any other run that goes on is `SCHEDULE_RUN_BUSY`. Web starts it at once.
 */
export async function insertManualRun(
  db: Db,
  input: { scheduleId: string; userId: string; now: Date },
): Promise<{ runId: string; created: boolean }> {
  return db.$transaction(async (tx) => {
    const task = await ownSchedule(tx, input.scheduleId, input.userId)
    const dueAt = new Date(Math.floor(input.now.getTime() / MINUTE_MS) * MINUTE_MS)
    const trigger: ScheduledRunTrigger = 'manual'
    const same = await tx.scheduledRun.findUnique({
      where: { scheduledTaskId_dueAt_trigger: { scheduledTaskId: task.id, dueAt, trigger } },
      select: { id: true },
    })
    if (same) return { runId: same.id, created: false }
    const going = await runGoingOn(tx, task.id)
    if (going?.status === 'pending' && going.trigger === trigger)
      return { runId: going.id, created: false }
    if (going !== null) throw scheduleRunBusy()
    const id = uuidv7()
    if (!(await insertRun(tx, { id, ...snapshotOf(task), dueAt, trigger, status: 'pending' })))
      throw scheduleRunBusy()
    await tx.scheduledTask.update({ where: { id: task.id }, data: { lastRunAt: dueAt } })
    return { runId: id, created: true }
  })
}

/**
 * A run of «Запустить сейчас» web could not start for a fault of the platform (503, §4.3): gone,
 * as if never pressed. Only while it waits — under its task's row, as every writer of the outcome:
 * a start of the same run in flight (a second press) is waited for, and a run it bound to its chat
 * stays.
 */
export async function dropPendingRun(db: Db, runId: string): Promise<boolean> {
  return db.$transaction(async (tx) => {
    if (!(await lockWaitingRun(tx, runId))) return false
    const { count } = await tx.scheduledRun.deleteMany({
      where: { id: runId, status: 'pending', taskId: null },
    })
    return count === 1
  })
}

/** What web answered of a run (§4.3). */
export type ScheduledRunOutcome =
  | { status: 'started'; taskId: string }
  | { status: 'refused' | 'skipped'; reason: ScheduledRunReason }

export interface RecordedRunOutcome {
  /** false — the run was not waiting: its outcome was recorded before; nothing changed. */
  recorded: boolean
  scheduledTaskId: string
  trigger: ScheduledRunTrigger
  /** The task stopped by this outcome, and why; null — it did not. */
  paused: SchedulePausedReason | null
  /** A refusal for the reason of the one before it, with no start between (Зп39). */
  repeated: boolean
  refusalStreak: number
}

/** Refusals that stop the task at once, by any trigger (ПР19): its project was put away. */
const pausingReasons = {
  project_gone: 'project_gone',
} as const satisfies Partial<Record<ScheduledRunReason, SchedulePausedReason>>

/**
 * The outcome of a run, once (Зп21, Зп22): only a run that waits takes one. A start clears the
 * refusals in a row; a refusal of its schedule for a reason of the client adds to them, and the
 * third in a row stops the task (`refused`) (Зп48); a project put away stops it at once (ПР19). A
 * refusal of «Запустить сейчас» is told in the cabinet and counts for nothing.
 */
export async function recordRunOutcome(
  db: Db,
  runId: string,
  outcome: ScheduledRunOutcome,
  now: Date = new Date(),
): Promise<RecordedRunOutcome> {
  return db.$transaction((tx) => recordRunOutcomeInTx(tx, runId, outcome, now))
}

/**
 * `recordRunOutcome` in the caller's transaction: the chat of a run is bound to it by the very
 * transaction that makes the chat (`createDialog` of @repo/trpc, after `lockWaitingRun`), so no
 * chat of a run is ever seen without its run, nor a run closed while its chat is being made.
 */
export async function recordRunOutcomeInTx(
  tx: Tx,
  runId: string,
  outcome: ScheduledRunOutcome,
  now: Date,
): Promise<RecordedRunOutcome> {
  const run = await tx.scheduledRun.findUnique({
    where: { id: runId },
    select: { scheduledTaskId: true, trigger: true },
  })
  if (!run) throw scheduleNotFound()
  const trigger = run.trigger as ScheduledRunTrigger
  // The task first, then the run: the order every writer of runs takes.
  const task = await lockSchedule(tx, run.scheduledTaskId)
  const result: RecordedRunOutcome = {
    recorded: false,
    scheduledTaskId: run.scheduledTaskId,
    trigger,
    paused: null,
    repeated: false,
    refusalStreak: task?.refusalStreak ?? 0,
  }
  const { count } = await tx.scheduledRun.updateMany({
    where: { id: runId, status: 'pending' },
    data:
      outcome.status === 'started'
        ? { status: 'started', taskId: outcome.taskId, startedAt: now }
        : {
            status: outcome.status,
            reason: outcome.reason,
            ...(outcome.reason === 'missed' ? { missedCount: 1 } : {}),
          },
  })
  if (count === 0 || !task) return result
  result.recorded = true
  if (task.deletedAt !== null) return result
  if (outcome.status === 'started') {
    await tx.scheduledTask.update({
      where: { id: task.id },
      data: { refusalStreak: 0, lastRefusalReason: null },
    })
    result.refusalStreak = 0
    return result
  }
  if (outcome.status !== 'refused') return result
  const stops = (pausingReasons as Partial<Record<string, SchedulePausedReason>>)[outcome.reason]
  const counted = trigger === 'schedule' && isClientRefusalReason(outcome.reason)
  const streak = counted ? task.refusalStreak + 1 : task.refusalStreak
  result.refusalStreak = streak
  result.repeated = trigger === 'schedule' && task.lastRefusalReason === outcome.reason
  const pause: SchedulePausedReason | undefined =
    stops ?? (counted && streak >= scheduleLimits.refusalsToPause ? 'refused' : undefined)
  const stopping = pause !== undefined && (task.enabled || task.pausedReason === null)
  await tx.scheduledTask.update({
    where: { id: task.id },
    data: {
      ...(trigger === 'schedule'
        ? { refusalStreak: streak, lastRefusalReason: outcome.reason }
        : {}),
      ...(stopping ? { enabled: false, nextRunAt: null, pausedReason: pause } : {}),
    },
  })
  if (stopping) result.paused = pause
  return result
}

/**
 * The run whose chat `createDialog` was making was closed before it — by the sweep, by core giving
 * its last delivery up, by «Запустить сейчас» dropping it — or is gone: the chat is not made, and
 * the start answers what the run holds.
 */
export const scheduledRunClosed = (): DomainError =>
  new DomainError('SCHEDULE_RUN_CLOSED', 'The run no longer waits for its chat', 409)

/**
 * The start of a run takes its task's row first (Зп20): every writer of the outcome of a run —
 * the sweep, the last delivery of core giving up, «Запустить сейчас» dropping its run — takes it
 * too, so none closes the run while its chat is being made. Taken before anything else of the
 * transaction that makes the chat. Whether the run still waits; false — its outcome is recorded, or
 * it is gone.
 */
export async function lockWaitingRun(tx: Tx, runId: string): Promise<boolean> {
  const run = await tx.scheduledRun.findUnique({
    where: { id: runId },
    select: { scheduledTaskId: true },
  })
  if (!run) return false
  await lockSchedule(tx, run.scheduledTaskId)
  const now = await tx.scheduledRun.findUnique({ where: { id: runId }, select: { status: true } })
  return now?.status === 'pending'
}

/**
 * The request a pass answers, the bound of `passUnattended`: its `feed.request` by id — what
 * core's job of the pass names —, or the instant it was written — what the plan of its turn keeps
 * (`committedAt`, to the millisecond; the feed keeps microseconds, so the bound is the end of that
 * millisecond).
 */
export type PassRequest = { requestEventId: string | bigint } | { answeredAt: Date }

/**
 * Whether a pass of a chat goes without its client (Зп27): the chat is a run's, and its feed holds
 * no request but its first — the instructions — up to the request the pass answers. Decided for
 * the pass: what the client writes while it runs — «Остановить», «Отправить сейчас» — is for the
 * passes after it, and lifts nothing of this one, whose agent never saw a word of the client. From
 * the first words of the client on, the chat is an ordinary one. Without `answers` — the whole
 * feed: a reader that does not know the pass.
 */
export async function passUnattended(
  db: Pick<PrismaClient, 'scheduledRun' | 'taskEvent'>,
  taskId: string,
  answers?: PassRequest,
): Promise<boolean> {
  const run = await db.scheduledRun.findUnique({ where: { taskId }, select: { id: true } })
  if (!run) return false
  return onlyFirstRequest(db, taskId, answers)
}

/** The feed of a chat holds no request but its first: its client has not spoken in it (Зп27). */
async function onlyFirstRequest(
  db: Pick<PrismaClient, 'taskEvent'>,
  taskId: string,
  answers: PassRequest | undefined,
): Promise<boolean> {
  const bound: Prisma.TaskEventWhereInput =
    answers === undefined
      ? {}
      : 'requestEventId' in answers
        ? { id: { lte: BigInt(answers.requestEventId) } }
        : { createdAt: { lt: new Date(answers.answeredAt.getTime() + 1) } }
  const requests = await db.taskEvent.findMany({
    where: { taskId, clientVisible: true, type: 'feed.request', ...bound },
    select: { id: true },
    orderBy: { id: 'asc' },
    take: 2,
  })
  return requests.length <= 1
}

// ———————————————————————————————————————— the agent's reservations (Зп31–Зп33)

/** What a turn asks of the tasks, as the `schedule` tools take it; the rights are the chat's. */
export type ScheduleChangeRequest =
  | ({ kind: 'create' } & Omit<ScheduleCreateArguments, 'confirmedByClient'>)
  | ({ kind: 'update' } & Omit<ScheduleUpdateArguments, 'confirmedByClient'>)
  | ({ kind: 'delete' } & Omit<ScheduleDeleteArguments, 'confirmedByClient'>)

/** The fields of a creation a reservation holds, checked and with its single runs as moments. */
interface CreationPayload extends ScheduleFields {
  /** The project of the chat (ПР19). */
  projectId: string | null
  /** Set up in a chat of a project with a repository: off, until the client turns it on (ПР19). */
  unconfirmed?: boolean
  enabled: boolean
  /** It would enable a task: counted against the 20 (Зп16). */
  enables: boolean
}

/** What an update holds: the fields it sets, checked, and the name of the task then. */
interface UpdatePayload {
  patch: ScheduledTaskPatch
  enables: boolean
  name: string
}

interface DeletionPayload {
  enables: false
  name: string
}

export interface ReservedScheduleChange {
  reservationId: string
  kind: ScheduleLeftAction
  /** The task it changes; null — a creation. */
  scheduleId: string | null
  /** The task as it will be; null — a deletion, or a reservation cancelled. */
  fields: (ScheduleFields & { enabled: boolean; projectId: string | null }) | null
  /** It will wait, off, until the client turns it on in the chat (ПР19). */
  needsClient: boolean
  /** Its next due moment then; null — paused, only by hand, or none. */
  nextRunAt: Date | null
  /** `schedule_delete` of a reservation of this turn: it is gone, nothing will change. */
  cancelled: boolean
}

/**
 * The chat of a turn: its workspace locked, its author and its project; `guarded` — the project has
 * a repository, so the tasks its agent sets up or changes wait for the client (ПР19).
 */
async function lockChat(tx: Tx, workspaceId: string, taskId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT w.id FROM workspaces w
    WHERE w.id = ${workspaceId}::uuid
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${taskId}::uuid AND t.workspace_id = w.id)
    FOR NO KEY UPDATE OF w`
  if (rows.length === 0) throw scheduleNotFound()
  const chat = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { id: true, createdById: true, workspaceId: true, projectId: true },
  })
  if (!chat.createdById || !(await chatAuthorManages(tx, taskId, workspaceId)))
    throw scheduleForbidden()
  return {
    ...chat,
    authorId: chat.createdById,
    guarded: await projectHasRepository(tx, chat.projectId),
  }
}

type LockedChat = Awaited<ReturnType<typeof lockChat>>

/**
 * A task of the chat's author in the chat's workspace — their personal one (Зп31, Зп54) — and of
 * the chat's project, or without one in a chat without one (ПР19): what `schedule_list` shows.
 */
async function chatSchedule(tx: Tx, chat: LockedChat, scheduleId: string): Promise<ScheduledTask> {
  const task = await lockSchedule(tx, scheduleId)
  if (
    !task ||
    task.deletedAt !== null ||
    task.workspaceId !== chat.workspaceId ||
    task.createdById !== chat.authorId ||
    task.projectId !== chat.projectId
  )
    throw scheduleNotFound()
  return task
}

/** The patch of an update as the tools give it, its single runs from now resolved. */
function toolPatch(
  args: Omit<ScheduleUpdateArguments, 'confirmedByClient' | 'scheduleId' | 'reservedId'>,
  timezone: string,
  now: Date,
): ScheduledTaskPatch {
  return {
    ...(args.name !== undefined ? { name: args.name } : {}),
    ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
    ...(args.effort !== undefined ? { effort: args.effort } : {}),
    ...(args.timezone !== undefined ? { timezone: checkedTimezone(args.timezone) } : {}),
    ...(args.triggers !== undefined
      ? { triggers: checkedTriggers(resolved(args.triggers, timezone, now)) }
      : {}),
    ...(args.notify !== undefined ? { notify: args.notify } : {}),
    ...(args.enabled !== undefined ? { enabled: args.enabled } : {}),
  }
}

const resolved = (triggers: readonly ScheduleToolTrigger[], timezone: string, now: Date) =>
  resolveScheduleToolTriggers(triggers, timezone, now)

/**
 * An agent's change of a task in a chat of a project with a repository (ПР19): it never turns the
 * task on — SCHEDULE_NEEDS_CLIENT —, and a change of the instructions or of when it runs turns it
 * off until the client turns it on again by «Включить задачу», which signs exactly those words.
 * `pauseAs` — the reason the task stops then.
 */
function guardedPatch(
  chat: LockedChat,
  task: ScheduledTask,
  patch: ScheduledTaskPatch,
): { patch: ScheduledTaskPatch; pauseAs?: 'unconfirmed' } {
  if (!chat.guarded) return { patch }
  if (patch.enabled === true && !task.enabled) throw scheduleNeedsClient()
  const words =
    patch.instructions !== undefined || patch.triggers !== undefined || patch.timezone !== undefined
  if (!words) return { patch }
  return { patch: { ...patch, enabled: false }, pauseAs: 'unconfirmed' }
}

/**
 * A creation's fields, checked as they will be stored: the project of the chat live, the next run
 * ahead, the 20 kept. In a chat of a project with a repository it is off and waits for the client
 * (ПР19): the agent never turns it on.
 */
async function checkCreation(
  tx: Tx,
  chat: LockedChat,
  payload: Omit<CreationPayload, 'enables' | 'projectId' | 'unconfirmed'>,
  now: Date,
  except?: string,
): Promise<{ payload: CreationPayload; nextRunAt: Date | null }> {
  const fields = checkedFields(payload)
  await checkProject(tx, chat.projectId, { userId: chat.authorId, workspaceId: chat.workspaceId })
  const nextRunAt = nextRunFor(fields, now)
  const unconfirmed = chat.guarded
  const enabled = payload.enabled && !unconfirmed
  if (enabled) {
    const taken =
      (await enabledTasks(tx, chat.workspaceId)) +
      (await enablingReservations(tx, chat.workspaceId, except))
    if (taken >= scheduleLimits.activePerWorkspace) throw scheduleLimitReached()
  }
  return {
    payload: {
      ...fields,
      projectId: chat.projectId,
      ...(unconfirmed ? { unconfirmed: true } : {}),
      enabled,
      enables: enabled,
    },
    nextRunAt: enabled ? nextRunAt : null,
  }
}

/**
 * An update as it will apply to the task now: the patch as the chat may make it (`guardedPatch`),
 * the fields then, whether it enables it, and whether it leaves the task waiting for the client.
 */
async function checkUpdate(
  tx: Tx,
  chat: LockedChat,
  task: ScheduledTask,
  asked: ScheduledTaskPatch,
  now: Date,
  except?: string,
): Promise<PlannedChange & { patch: ScheduledTaskPatch; needsClient: boolean }> {
  const { patch, pauseAs } = guardedPatch(chat, task, asked)
  // The rules changeInTx applies at the end of the turn; the reservations open count here.
  const planned = planChange(task, patch, now)
  if (planned.enabling) {
    await checkProject(tx, task.projectId, {
      userId: task.createdById,
      workspaceId: task.workspaceId,
    })
    const taken =
      (await enabledTasks(tx, chat.workspaceId, task.id)) +
      (await enablingReservations(tx, chat.workspaceId, except))
    if (taken >= scheduleLimits.activePerWorkspace) throw scheduleLimitReached()
  }
  const needsClient =
    pauseAs !== undefined || (!planned.enabled && task.pausedReason === 'unconfirmed')
  return { ...planned, patch, needsClient }
}

/** Open reservations of a turn: at most five changes a turn (Зп31). */
async function checkTurnRoom(tx: Tx, taskId: string, turnNo: number): Promise<void> {
  const open = await tx.scheduleReservation.count({ where: { taskId, turnNo, outcome: null } })
  if (open >= scheduleLimits.changesPerTurn) throw scheduleChangeLimitReached()
}

/** An open reservation of this turn, by its id; another turn's or a closed one is not found. */
async function ownReservation(
  tx: Tx,
  reservationId: string,
  taskId: string,
  turnNo: number,
): Promise<ScheduleReservation> {
  const row = await tx.scheduleReservation.findUnique({ where: { id: reservationId } })
  if (!row || row.taskId !== taskId || row.turnNo !== turnNo || row.outcome !== null)
    throw scheduleNotFound()
  return row
}

async function closeReservations(
  tx: Tx,
  where: Prisma.ScheduleReservationWhereInput,
  outcome: ScheduleReservationOutcome,
  now: Date,
): Promise<void> {
  await tx.scheduleReservation.updateMany({
    where: { ...where, outcome: null },
    data: { outcome, closedAt: now },
  })
}

const creationOf = (row: ScheduleReservation) => row.payload as unknown as CreationPayload
const updateOf = (row: ScheduleReservation) => row.payload as unknown as UpdatePayload

/**
 * `schedule_create`, `schedule_update`, `schedule_delete` (Зп31–Зп33): a reservation of the turn,
 * checked now — the author manages the workspace, the task is theirs, the words and the
 * schedules pass, a single run is ahead, at most
 * five changes a turn and 20 enabled tasks a workspace with the reservations open — and applied
 * by core when the turn ended. `reservedId` amends or cancels a reservation of this turn; a second
 * change of one task in a turn amends the first.
 */
export async function reserveScheduleChange(
  db: Db,
  input: {
    workspaceId: string
    taskId: string
    turnNo: number
    change: ScheduleChangeRequest
    now: Date
  },
): Promise<ReservedScheduleChange> {
  const { taskId, turnNo, change, now } = input
  return db.$transaction(async (tx) => {
    const chat = await lockChat(tx, input.workspaceId, taskId)
    const turn = { taskId, turnNo }

    if (change.kind === 'create') {
      // A chat of a project sets up tasks of it, a chat without one tasks without one (ПР19).
      if (
        change.project !== undefined &&
        (change.project === 'this_chat') !== (chat.projectId !== null)
      )
        throw badRequest(
          chat.projectId === null
            ? 'A chat without a project sets up tasks without a project: project "none" or none given'
            : 'A chat of a project sets up tasks of this project: project "this_chat" or none given',
        )
      const author = await tx.user.findUnique({
        where: { id: chat.authorId },
        select: { timezone: true },
      })
      const timezone = checkedTimezone(
        change.timezone ?? author?.timezone ?? DEFAULT_SCHEDULE_TIMEZONE,
      )
      await checkTurnRoom(tx, taskId, turnNo)
      const { payload, nextRunAt } = await checkCreation(
        tx,
        chat,
        {
          name: change.name,
          instructions: change.instructions,
          effort: change.effort ?? 'high',
          triggers: checkedTriggers(resolved(change.triggers, timezone, now)),
          timezone,
          notify: change.notify ?? true,
          enabled: true,
        },
        now,
      )
      const row = await tx.scheduleReservation.create({
        data: {
          workspaceId: chat.workspaceId,
          ...turn,
          // The moment the agent asked (Зп15) is the clock of the turn, not of the database.
          createdAt: now,
          kind: 'create',
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      })
      return reserved(row, null, payload, nextRunAt, payload.unconfirmed === true)
    }

    if (change.kind === 'update') {
      const { scheduleId, reservedId, ...args } = change
      if (reservedId !== undefined) {
        const row = await ownReservation(tx, reservedId, taskId, turnNo)
        if (row.kind === 'delete') throw scheduleNotFound()
        if (row.kind === 'create') {
          const before = creationOf(row)
          const timezone = checkedTimezone(args.timezone ?? before.timezone)
          const patch = toolPatch(args, timezone, now)
          if (chat.guarded && patch.enabled === true) throw scheduleNeedsClient()
          const { payload, nextRunAt } = await checkCreation(
            tx,
            chat,
            {
              ...before,
              ...patch,
              triggers: patch.triggers !== undefined ? [...patch.triggers] : before.triggers,
              enabled: patch.enabled ?? before.enabled,
            },
            now,
            row.id,
          )
          const updated = await tx.scheduleReservation.update({
            where: { id: row.id },
            data: { payload: payload as unknown as Prisma.InputJsonValue },
          })
          return reserved(updated, null, payload, nextRunAt, payload.unconfirmed === true)
        }
        return amendUpdate(tx, chat, row, args, now)
      }
      if (scheduleId === undefined) throw scheduleNotFound()
      const task = await chatSchedule(tx, chat, scheduleId)
      const open = await tx.scheduleReservation.findMany({
        where: { ...turn, scheduleId: task.id, outcome: null },
        orderBy: { createdAt: 'asc' },
      })
      if (open.some((row) => row.kind === 'delete')) throw scheduleNotFound()
      const earlier = open.find((row) => row.kind === 'update')
      if (earlier) return amendUpdate(tx, chat, earlier, args, now)
      await checkTurnRoom(tx, taskId, turnNo)
      const asked = toolPatch(args, checkedTimezone(args.timezone ?? task.timezone), now)
      const checked = await checkUpdate(tx, chat, task, asked, now)
      const payload: UpdatePayload = {
        patch: checked.patch,
        enables: checked.enabling,
        name: task.name,
      }
      const row = await tx.scheduleReservation.create({
        data: {
          workspaceId: chat.workspaceId,
          ...turn,
          // The moment the agent asked (Зп15) is the clock of the turn, not of the database.
          createdAt: now,
          kind: 'update',
          scheduleId: task.id,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      })
      return reserved(
        row,
        task.id,
        { ...checked.fields, enabled: checked.enabled, projectId: task.projectId },
        checked.nextRunAt,
        checked.needsClient,
      )
    }

    // A deletion: of a reservation of this turn — it is cancelled —, or of a task.
    if (change.reservedId !== undefined) {
      const row = await ownReservation(tx, change.reservedId, taskId, turnNo)
      await closeReservations(tx, { id: row.id }, 'refused', now)
      return {
        reservationId: row.id,
        kind: row.kind as ScheduleLeftAction,
        scheduleId: row.scheduleId,
        fields: null,
        nextRunAt: null,
        needsClient: false,
        cancelled: true,
      }
    }
    if (change.scheduleId === undefined) throw scheduleNotFound()
    const task = await chatSchedule(tx, chat, change.scheduleId)
    const open = await tx.scheduleReservation.findMany({
      where: { ...turn, scheduleId: task.id, outcome: null },
    })
    const deletion = open.find((row) => row.kind === 'delete')
    if (deletion) return reserved(deletion, task.id, null, null)
    // An update of the task this turn asked before gives way to its deletion.
    await closeReservations(tx, { ...turn, scheduleId: task.id, kind: 'update' }, 'refused', now)
    await checkTurnRoom(tx, taskId, turnNo)
    const payload: DeletionPayload = { enables: false, name: task.name }
    const row = await tx.scheduleReservation.create({
      data: {
        workspaceId: chat.workspaceId,
        ...turn,
        // The moment the agent asked (Зп15) is the clock of the turn, not of the database.
        createdAt: now,
        kind: 'delete',
        scheduleId: task.id,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    })
    return reserved(row, task.id, null, null)
  })
}

function reserved(
  row: ScheduleReservation,
  scheduleId: string | null,
  task: (ScheduleFields & { enabled: boolean; projectId: string | null }) | null,
  nextRunAt: Date | null,
  needsClient = false,
): ReservedScheduleChange {
  return {
    reservationId: row.id,
    kind: row.kind as ScheduleLeftAction,
    scheduleId,
    fields:
      task === null
        ? null
        : {
            name: task.name,
            instructions: task.instructions,
            effort: task.effort,
            triggers: task.triggers,
            timezone: task.timezone,
            notify: task.notify,
            enabled: task.enabled,
            projectId: task.projectId,
          },
    nextRunAt,
    needsClient,
    cancelled: false,
  }
}

/** A second update of one task in a turn: its patch over the first one's, checked again. */
async function amendUpdate(
  tx: Tx,
  chat: LockedChat,
  row: ScheduleReservation,
  args: Omit<ScheduleUpdateArguments, 'confirmedByClient' | 'scheduleId' | 'reservedId'>,
  now: Date,
): Promise<ReservedScheduleChange> {
  if (row.scheduleId === null) throw scheduleNotFound()
  const task = await chatSchedule(tx, chat, row.scheduleId)
  const before = updateOf(row)
  const timezone = checkedTimezone(args.timezone ?? before.patch.timezone ?? task.timezone)
  const patch = { ...before.patch, ...toolPatch(args, timezone, now) }
  const checked = await checkUpdate(tx, chat, task, patch, now, row.id)
  const payload: UpdatePayload = {
    patch: checked.patch,
    enables: checked.enabling,
    name: task.name,
  }
  const updated = await tx.scheduleReservation.update({
    where: { id: row.id },
    data: { payload: payload as unknown as Prisma.InputJsonValue },
  })
  return reserved(
    updated,
    task.id,
    { ...checked.fields, enabled: checked.enabled, projectId: task.projectId },
    checked.nextRunAt,
    checked.needsClient,
  )
}

/** The open changes of a turn, in the order they were asked (Зп33). */
export function pendingScheduleChanges(
  db: Pick<PrismaClient, 'scheduleReservation'>,
  taskId: string,
  turnNo: number,
) {
  return db.scheduleReservation.findMany({
    where: { taskId, turnNo, outcome: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, kind: true, scheduleId: true, payload: true, createdAt: true },
  })
}

export interface AppliedScheduleChange {
  action: ScheduleChangeAction
  schedule: ScheduledTask
}

/**
 * Applies a change a turn reserved, at its end (Зп33): everything checked again — the author still
 * manages the workspace, the task is still theirs, the words, the
 * schedules and the 20 — then the change and the close of its reservation in one transaction. A
 * single run the agent asked for, due by now but not before it asked and not older than the
 * catch-up limit, becomes the due moment the next tick runs (Зп15). A refusal throws and closes
 * nothing: the caller refuses the reservation and tells the client.
 */
export async function applyScheduleChange(
  db: Db,
  input: { reservationId: string; workspaceId: string; taskId: string; now: Date },
): Promise<AppliedScheduleChange> {
  const { now } = input
  return db.$transaction(async (tx) => {
    const chat = await lockChat(tx, input.workspaceId, input.taskId)
    // The reservation's row: a sweep that refuses it waits, or is waited for.
    await tx.$queryRaw`
      SELECT id FROM schedule_reservations WHERE id = ${input.reservationId}::uuid FOR UPDATE`
    const row = await tx.scheduleReservation.findUnique({ where: { id: input.reservationId } })
    if (!row || row.taskId !== input.taskId || row.outcome !== null) throw scheduleNotFound()
    const close = async (scheduleId?: string) => {
      await tx.scheduleReservation.update({
        where: { id: row.id },
        data: { outcome: 'done', closedAt: now, ...(scheduleId ? { scheduleId } : {}) },
      })
    }

    if (row.kind === 'create') {
      const payload = creationOf(row)
      // The project of the chat: a reservation never makes a task of another one (ПР19).
      if ((payload.projectId ?? null) !== chat.projectId) throw scheduleNotFound()
      // A project that got its repository since waits for the client as well.
      const unconfirmed = payload.unconfirmed === true || chat.guarded
      const data = await newTaskData(
        tx,
        {
          userId: chat.authorId,
          workspaceId: chat.workspaceId,
          projectId: chat.projectId,
          name: payload.name,
          instructions: payload.instructions,
          effort: payload.effort,
          triggers: payload.triggers,
          timezone: payload.timezone,
          notify: payload.notify,
          enabled: payload.enabled && !unconfirmed,
          createdVia: 'chat',
          sourceTaskId: input.taskId,
        },
        now,
        row.createdAt,
      )
      const schedule = await tx.scheduledTask.create({
        data: unconfirmed ? { ...data, pausedReason: 'unconfirmed' } : data,
      })
      await close(schedule.id)
      return { action: 'created', schedule }
    }

    if (row.scheduleId === null) throw scheduleNotFound()
    const task = await chatSchedule(tx, chat, row.scheduleId)
    if (row.kind === 'delete') {
      const schedule = await tx.scheduledTask.update({
        where: { id: task.id },
        data: { deletedAt: now, enabled: false, nextRunAt: null },
      })
      await close()
      return { action: 'deleted', schedule }
    }
    // Guarded again: the project may have got its repository since the turn asked (ПР19).
    const { patch, pauseAs } = guardedPatch(chat, task, updateOf(row).patch)
    const { row: schedule, action } = await changeInTx(tx, task, patch, now, row.createdAt, pauseAs)
    await close()
    return { action, schedule }
  })
}

export interface RefusedScheduleChange {
  id: string
  kind: ScheduleLeftAction
  scheduleId: string | null
  /** The name the reservation held: what `feed.schedule_left` may tell. */
  name: string | null
}

/**
 * Closes the open changes of a turn without applying them (Зп33): a change the end of its turn
 * refused (`refused`), the changes of a pass that failed or was cancelled (`failed`). Only the
 * ones named, or all the open ones of the turn — of every turn of the chat without `turnNo`.
 * Returns what it closed, never one twice.
 */
export async function refuseScheduleChanges(
  db: Db,
  input: {
    taskId: string
    turnNo?: number
    reservationIds?: readonly string[]
    outcome: Exclude<ScheduleReservationOutcome, 'done'>
    now?: Date
  },
): Promise<RefusedScheduleChange[]> {
  const now = input.now ?? new Date()
  return db.$transaction(async (tx) => {
    // The open rows of the chat, locked in one order: an end of a turn applying one waits.
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM schedule_reservations
      WHERE task_id = ${input.taskId}::uuid AND outcome IS NULL
      ORDER BY id FOR UPDATE`
    const named = input.reservationIds !== undefined ? new Set(input.reservationIds) : null
    const open = await tx.scheduleReservation.findMany({
      where: {
        id: { in: locked.map((row) => row.id).filter((id) => named === null || named.has(id)) },
        outcome: null,
        ...(input.turnNo !== undefined ? { turnNo: input.turnNo } : {}),
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    })
    await closeReservations(tx, { id: { in: open.map((row) => row.id) } }, input.outcome, now)
    return open.map((row) => ({
      id: row.id,
      kind: row.kind as ScheduleLeftAction,
      scheduleId: row.scheduleId,
      name: nameOf(row),
    }))
  })
}

const nameOf = (row: ScheduleReservation): string | null => {
  const name = (row.payload as { name?: unknown } | null)?.name
  return typeof name === 'string' ? name : null
}

/**
 * Changes no end of a turn settled, older than `before`, whose turn is over — the chat went past
 * it or does not work — or, given `anyBefore`, older than that whatever the turn: the sweep of core
 * closes them (`failed`) and tells the client.
 */
export async function staleScheduleReservations(
  db: Pick<PrismaClient, '$queryRaw'>,
  input: { before: Date; anyBefore?: Date; limit?: number },
): Promise<{ id: string; taskId: string; turnNo: number; kind: ScheduleLeftAction }[]> {
  const anyBefore = input.anyBefore ?? new Date(0)
  const rows = await db.$queryRaw<{ id: string; task_id: string; turn_no: number; kind: string }[]>`
    SELECT r.id, r.task_id, r.turn_no, r.kind
    FROM schedule_reservations r JOIN tasks t ON t.id = r.task_id
    WHERE r.outcome IS NULL
      AND (
        (r.created_at < ${input.before}
          AND (t.turn_no > r.turn_no OR t.status::text NOT IN ('preparing', 'running')))
        OR r.created_at < ${anyBefore}
      )
    ORDER BY r.created_at, r.id
    LIMIT ${input.limit ?? 100}`
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    turnNo: row.turn_no,
    kind: row.kind as ScheduleLeftAction,
  }))
}
