import {
  badRequest,
  DEFAULT_SCHEDULE_TIMEZONE,
  DomainError,
  dueCountBetween,
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
  scheduleErrorOfIssues,
  scheduleForbidden,
  scheduleInPast,
  scheduleInstructionsSchema,
  scheduleLimitReached,
  scheduleLimits,
  scheduleNameSchema,
  scheduleNotFound,
  scheduleRunBusy,
  scheduleStartDedupeKey,
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

/** The project of a task is not one of its workspace, or it was deleted. */
const projectNotFound = () => new DomainError('NOT_FOUND', 'No such project in the workspace', 404)

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

/**
 * The next due moment of schedules saved now (Зп13, Зп15): from now, always ahead; null — only by
 * hand. A single run in the past is not saved — `SCHEDULE_IN_PAST` — even when another schedule
 * runs on. `recentSince`: the moment the agent asked for it (Зп15) — a single run that was ahead
 * then and is due now, not older than the catch-up limit, is kept and becomes the due moment the
 * next tick runs at once.
 */
function nextRunFor(fields: ScheduleFields, now: Date, recentSince?: Date): Date | null {
  const { triggers, timezone } = fields
  if (triggers.length === 0) return null
  const next = nextRunOf(triggers, timezone, now)
  if (!scheduleTriggersInPast(triggers, timezone, now)) {
    if (next === null) throw scheduleInPast()
    return next
  }
  if (recentSince === undefined) throw scheduleInPast()
  const since = Math.max(
    recentSince.getTime(),
    now.getTime() - scheduleLimits.catchUpHours * HOUR_MS,
  )
  let earliest: Date | null = null
  for (const trigger of triggers) {
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

/** Several workspaces in the order of their ids: two moves the other way never wait on each other. */
async function lockWorkspaces(tx: Tx, workspaceIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(workspaceIds)].sort())
    if (!(await lockWorkspace(tx, id))) throw scheduleNotFound()
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

/** The project of a task, alive and of its workspace. */
async function checkProject(tx: Tx, siteId: string | null, workspaceId: string): Promise<void> {
  if (siteId === null) return
  const site = await tx.site.findUnique({
    where: { id: siteId },
    select: { workspaceId: true, deletedAt: true },
  })
  if (!site || site.workspaceId !== workspaceId || site.deletedAt !== null) throw projectNotFound()
}

/** A task of its creator, alive; another's or a deleted one is never told apart (Зп25). */
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
  /** The workspace of the project; without one — the creator's personal workspace. */
  workspaceId: string
  siteId: string | null
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
  await checkProject(tx, input.siteId, input.workspaceId)
  const enabled = input.enabled ?? true
  const nextRunAt = nextRunFor(fields, now, recentSince)
  if (enabled) await checkRoom(tx, input.workspaceId)
  return {
    id: uuidv7(),
    workspaceId: input.workspaceId,
    siteId: input.siteId,
    createdById: input.userId,
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
 * «Создать» of the window (Зп7, Зп9): the creator manages the workspace, the project is its own
 * and alive, the fields pass the rules of the domain, a single run is ahead, and an enabled task
 * fits the 20 of the workspace — counted under its row.
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
  /** Another project, or none, with the workspace it belongs to (Зп16, Зп25). */
  project?: { siteId: string | null; workspaceId: string }
  /** Paused (false) or resumed (true); left out — as it is. */
  enabled?: boolean
}

const sameTriggers = (a: readonly ScheduleTrigger[], b: readonly ScheduleTrigger[]) =>
  JSON.stringify(a) === JSON.stringify(b)

/** What a change makes of a task (Зп13, Зп15): its fields, its state and its due moment. */
interface PlannedChange {
  fields: ScheduleFields
  enabled: boolean
  /** It turns the task on: counted against the 20 (Зп16), its project checked. */
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
  if (!enabled) nextRunAt = null
  else if (rescheduled || enabling) nextRunAt = nextRunFor(fields, now, recentSince)
  return { fields, enabled, enabling, pausing: task.enabled && !enabled, nextRunAt }
}

/**
 * A change of a locked task, in the caller's transaction with the workspaces locked (Зп13–Зп16):
 * a task enabled — or moved to another workspace enabled — fits the 20 there, its project alive.
 */
async function changeInTx(
  tx: Tx,
  task: ScheduledTask,
  patch: ScheduledTaskPatch,
  now: Date,
  recentSince?: Date,
): Promise<{ row: ScheduledTask; action: Exclude<ScheduleChangeAction, 'created' | 'deleted'> }> {
  const { fields, enabled, enabling, pausing, nextRunAt } = planChange(
    task,
    patch,
    now,
    recentSince,
  )
  const workspaceId = patch.project?.workspaceId ?? task.workspaceId
  const siteId = patch.project !== undefined ? patch.project.siteId : task.siteId
  const moved = workspaceId !== task.workspaceId || siteId !== task.siteId
  if (moved || enabling) await checkProject(tx, siteId, workspaceId)
  if (enabled && (enabling || workspaceId !== task.workspaceId))
    await checkRoom(tx, workspaceId, task.id)
  const row = await tx.scheduledTask.update({
    where: { id: task.id },
    data: {
      name: fields.name,
      instructions: fields.instructions,
      effort: fields.effort,
      triggers: fields.triggers as Prisma.InputJsonValue,
      timezone: fields.timezone,
      notify: fields.notify,
      workspaceId,
      siteId,
      enabled,
      nextRunAt,
      // A task paused by the client has no reason of its own; one resumed is a fresh start.
      ...(enabled || pausing ? { pausedReason: null } : {}),
      ...(enabling ? { refusalStreak: 0, lastRefusalReason: null } : {}),
    },
  })
  return { row, action: enabling ? 'resumed' : pausing ? 'paused' : 'updated' }
}

/**
 * «Сохранить» of the window (Зп7): by its creator while they manage its workspace — and, for a
 * move, the workspace it goes to. The name, the words, «Размышление» and the notices leave the due
 * moment as it was (Зп13).
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
    if (!before) throw scheduleNotFound()
    const target = input.patch.project?.workspaceId
    await lockWorkspaces(
      tx,
      target !== undefined ? [before.workspaceId, target] : [before.workspaceId],
    )
    const task = await ownSchedule(tx, input.scheduleId, input.userId)
    // A move between the reading and the lock: the workspace locked is no longer its own.
    if (task.workspaceId !== before.workspaceId) throw scheduleNotFound()
    if (target !== undefined && !(await userManages(tx, input.userId, target)))
      throw scheduleForbidden()
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
    if (!before) throw scheduleNotFound()
    await lockWorkspaces(tx, [before.workspaceId])
    const task = await ownSchedule(tx, input.scheduleId, input.userId)
    if (task.enabled === input.enabled) return task
    return (await changeInTx(tx, task, { enabled: input.enabled }, input.now)).row
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

const runOfList = {
  orderBy: [{ createdAt: 'desc' }, { dueAt: 'desc' }],
  include: { task: { select: { id: true, status: true, title: true, deletedAt: true } } },
} satisfies Prisma.ScheduledTask$runsArgs

const siteOfList = { select: { id: true, name: true, url: true, deletedAt: true } } as const

/**
 * «Ваши» (Зп25): the tasks a user created, not deleted, in workspaces they are still a member of,
 * each with its latest run. `siteId` — of one project; null — without a project (`schedule_list`
 * of a chat without one, Зп31).
 */
export function listScheduledTasks(
  db: Pick<PrismaClient, 'scheduledTask'>,
  input: { userId: string; workspaceId?: string; siteId?: string | null },
) {
  return db.scheduledTask.findMany({
    where: {
      createdById: input.userId,
      deletedAt: null,
      workspace: { members: { some: { userId: input.userId } } },
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.siteId !== undefined ? { siteId: input.siteId } : {}),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: { site: siteOfList, runs: { ...runOfList, take: 1 } },
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
    include: { site: siteOfList, runs: { ...runOfList, take: 50 } },
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

// ———————————————————————————————————————— the project

/** What «Удалить проект» stops: the tasks of the project not deleted, not already finished. */
const stoppedBySiteDeletion = (siteId: string): Prisma.ScheduledTaskWhereInput => ({
  siteId,
  deletedAt: null,
  OR: [{ pausedReason: null }, { pausedReason: { notIn: ['completed', 'project_gone'] } }],
})

/** How many tasks «Удалить проект» stops: the window of the deletion names them (Зп22). */
export function countSiteSchedules(
  db: Pick<PrismaClient, 'scheduledTask'>,
  siteId: string,
): Promise<number> {
  return db.scheduledTask.count({ where: stoppedBySiteDeletion(siteId) })
}

/**
 * The tasks of a deleted project stop — `project_gone`, without a notice (Зп22) — in the
 * transaction of the deletion. Returns how many.
 */
export async function pauseSiteSchedules(tx: Tx, siteId: string): Promise<number> {
  await tx.$queryRaw`
    SELECT id FROM scheduled_tasks WHERE site_id = ${siteId}::uuid AND deleted_at IS NULL FOR UPDATE`
  const paused = await tx.scheduledTask.updateMany({
    where: stoppedBySiteDeletion(siteId),
    data: { enabled: false, nextRunAt: null, pausedReason: 'project_gone' },
  })
  return paused.count
}

/**
 * A task stops by itself (Зп21, Зп22): the gate of a chat refused its first pass (`not_accepted`),
 * the creator lost the right. A task the client paused takes the reason as well; one stopped for
 * another reason keeps its own. Returns whether it stopped now.
 */
export async function pauseSchedule(
  tx: Tx,
  scheduleId: string,
  reason: Exclude<SchedulePausedReason, 'completed'>,
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
  siteId: task.siteId,
  name: task.name,
  instructions: task.instructions,
  effort: task.effort,
})

/** Whether a run of the task goes on: one waits for web, or its chat works (Зп14, Зп24). */
async function runGoesOn(tx: Tx, scheduleId: string): Promise<boolean> {
  const busy = await tx.scheduledRun.findFirst({
    where: {
      scheduledTaskId: scheduleId,
      OR: [
        { status: 'pending' },
        { status: 'started', task: { status: { in: [...workingChatStatuses] } } },
      ],
    },
    select: { id: true },
  })
  return busy !== null
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
 * catch-up limit is not run. While a run of the task goes on, the moment is skipped. A run takes
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
    const written = await insertRun(tx, {
      id,
      ...snapshot,
      dueAt: from,
      trigger: 'schedule',
      status: 'skipped',
      reason: 'missed',
      missedCount,
    })
    if (written) claim.missedRunId = id
  }
  if (!tooLate) {
    const id = uuidv7()
    if (await runGoesOn(tx, task.id)) {
      const written = await insertRun(tx, {
        id,
        ...snapshot,
        dueAt: due,
        trigger: 'schedule',
        status: 'skipped',
        reason: 'previous_running',
      })
      if (written) claim.busyRunId = id
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
  // From now: the due moment is never after it.
  claim.nextRunAt = nextRunOf(triggers, task.timezone, now)
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

/** The tasks due by now, the earliest first: the tick claims each in its own transaction. */
export async function dueScheduleIds(
  db: Pick<PrismaClient, 'scheduledTask'>,
  now: Date,
  limit = 100,
): Promise<string[]> {
  const rows = await db.scheduledTask.findMany({
    where: { enabled: true, deletedAt: null, nextRunAt: { lte: now } },
    orderBy: [{ nextRunAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true },
  })
  return rows.map((row) => row.id)
}

/** Runs web never answered, older than `olderThan`: the tick closes them, «сбой платформы» (Зп21). */
export function stalePendingRuns(
  db: Pick<PrismaClient, 'scheduledRun'>,
  olderThan: Date,
  limit = 100,
) {
  return db.scheduledRun.findMany({
    where: { status: 'pending', createdAt: { lt: olderThan } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: limit,
    select: { id: true, scheduledTaskId: true, trigger: true, dueAt: true, attempts: true },
  })
}

/**
 * «Запустить сейчас» (Зп24): a run out of the schedule, written under the task's row by its
 * creator while they manage the workspace — of a paused task as well. Its moment is the minute,
 * so a second press of the same minute is the same run (`created: false`); a run that goes on is
 * `SCHEDULE_RUN_BUSY`. Web starts it at once.
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
    if (await runGoesOn(tx, task.id)) throw scheduleRunBusy()
    const id = uuidv7()
    if (!(await insertRun(tx, { id, ...snapshotOf(task), dueAt, trigger, status: 'pending' })))
      throw scheduleRunBusy()
    await tx.scheduledTask.update({ where: { id: task.id }, data: { lastRunAt: dueAt } })
    return { runId: id, created: true }
  })
}

/**
 * A run of «Запустить сейчас» web could not start for a fault of the platform (503, §4.3): gone,
 * as if never pressed. Only while it waits and has no chat.
 */
export async function dropPendingRun(
  db: Pick<PrismaClient, 'scheduledRun'>,
  runId: string,
): Promise<boolean> {
  const { count } = await db.scheduledRun.deleteMany({
    where: { id: runId, status: 'pending', taskId: null },
  })
  return count === 1
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

const pausingReasons = {
  project_gone: 'project_gone',
  member_gone: 'member_gone',
} as const satisfies Partial<Record<ScheduledRunReason, SchedulePausedReason>>

/**
 * The outcome of a run, once (Зп21, Зп22): only a run that waits takes one. A start clears the
 * refusals in a row; a refusal of its schedule for a reason of the client adds to them, and the
 * third in a row stops the task (`refused`); a project gone or a right lost stops it at once. A
 * refusal of «Запустить сейчас» is told in the cabinet and counts for nothing.
 */
export async function recordRunOutcome(
  db: Db,
  runId: string,
  outcome: ScheduledRunOutcome,
  now: Date = new Date(),
): Promise<RecordedRunOutcome> {
  return db.$transaction(async (tx) => {
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
    const pause =
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
  })
}

/**
 * Whether a pass of a chat goes without its client (Зп27): the chat is a run's, and its feed holds
 * no request but its first — the instructions. From the first words of the client on, it is an
 * ordinary chat.
 */
export async function passUnattended(
  db: Pick<PrismaClient, 'scheduledRun' | 'taskEvent'>,
  taskId: string,
): Promise<boolean> {
  const run = await db.scheduledRun.findUnique({ where: { taskId }, select: { id: true } })
  if (!run) return false
  const requests = await db.taskEvent.findMany({
    where: { taskId, type: 'feed.request' },
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
  siteId: string | null
  enabled: boolean
  /** It would enable a task: counted against the 20 (Зп16). */
  enables: boolean
}

/** What an update holds: the fields it sets, checked, and the name of the task then. */
interface UpdatePayload {
  patch: Omit<ScheduledTaskPatch, 'project'>
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
  fields: (ScheduleFields & { siteId: string | null; enabled: boolean }) | null
  /** Its next due moment then; null — paused, only by hand, or none. */
  nextRunAt: Date | null
  /** `schedule_delete` of a reservation of this turn: it is gone, nothing will change. */
  cancelled: boolean
}

/** The chat of a turn: its workspace locked, its author and project. */
async function lockChat(tx: Tx, workspaceId: string, taskId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT w.id FROM workspaces w
    WHERE w.id = ${workspaceId}::uuid
      AND EXISTS (SELECT 1 FROM tasks t WHERE t.id = ${taskId}::uuid AND t.workspace_id = w.id)
    FOR NO KEY UPDATE OF w`
  if (rows.length === 0) throw scheduleNotFound()
  const chat = await tx.task.findUniqueOrThrow({
    where: { id: taskId },
    select: { id: true, siteId: true, createdById: true, workspaceId: true },
  })
  if (!chat.createdById || !(await chatAuthorManages(tx, taskId, workspaceId)))
    throw scheduleForbidden()
  return { ...chat, authorId: chat.createdById }
}

type LockedChat = Awaited<ReturnType<typeof lockChat>>

/** A task of the chat's author and of the chat's project (Зп31): what `schedule_list` shows. */
async function chatSchedule(tx: Tx, chat: LockedChat, scheduleId: string): Promise<ScheduledTask> {
  const task = await lockSchedule(tx, scheduleId)
  if (
    !task ||
    task.deletedAt !== null ||
    task.workspaceId !== chat.workspaceId ||
    task.createdById !== chat.authorId ||
    task.siteId !== chat.siteId
  )
    throw scheduleNotFound()
  return task
}

/** The patch of an update as the tools give it, its single runs from now resolved. */
function toolPatch(
  args: Omit<ScheduleUpdateArguments, 'confirmedByClient' | 'scheduleId' | 'reservedId'>,
  timezone: string,
  now: Date,
): Omit<ScheduledTaskPatch, 'project'> {
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

/** A creation's fields, checked as they will be stored: the next run ahead, the 20 kept. */
async function checkCreation(
  tx: Tx,
  chat: LockedChat,
  payload: Omit<CreationPayload, 'enables'>,
  now: Date,
  except?: string,
): Promise<{ payload: CreationPayload; nextRunAt: Date | null }> {
  const fields = checkedFields(payload)
  await checkProject(tx, payload.siteId, chat.workspaceId)
  const nextRunAt = nextRunFor(fields, now)
  if (payload.enabled) {
    const taken =
      (await enabledTasks(tx, chat.workspaceId)) +
      (await enablingReservations(tx, chat.workspaceId, except))
    if (taken >= scheduleLimits.activePerWorkspace) throw scheduleLimitReached()
  }
  return {
    payload: {
      ...fields,
      siteId: payload.siteId,
      enabled: payload.enabled,
      enables: payload.enabled,
    },
    nextRunAt: payload.enabled ? nextRunAt : null,
  }
}

/** An update as it will apply to the task now: the fields then, and whether it enables it. */
async function checkUpdate(
  tx: Tx,
  chat: LockedChat,
  task: ScheduledTask,
  patch: Omit<ScheduledTaskPatch, 'project'>,
  now: Date,
  except?: string,
): Promise<PlannedChange> {
  // The rules changeInTx applies at the end of the turn; the reservations open count here.
  const planned = planChange(task, patch, now)
  if (planned.enabling) {
    await checkProject(tx, task.siteId, task.workspaceId)
    const taken =
      (await enabledTasks(tx, chat.workspaceId, task.id)) +
      (await enablingReservations(tx, chat.workspaceId, except))
    if (taken >= scheduleLimits.activePerWorkspace) throw scheduleLimitReached()
  }
  return planned
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
 * checked now — the author manages the workspace, the project is the chat's, the task is theirs
 * and of the chat's project, the words and the schedules pass, a single run is ahead, at most
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
      if ((change.project === 'this_chat') !== (chat.siteId !== null))
        throw badRequest(
          chat.siteId === null
            ? 'A chat without a project sets up tasks without a project: project "none". A task about a site is set up in a chat of its project or by hand in «Расписание»'
            : 'A chat of a project sets up tasks of this project: project "this_chat"',
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
          siteId: chat.siteId,
          enabled: true,
        },
        now,
      )
      const row = await tx.scheduleReservation.create({
        data: {
          workspaceId: chat.workspaceId,
          ...turn,
          kind: 'create',
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      })
      return reserved(row, null, payload, nextRunAt)
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
          return reserved(updated, null, payload, nextRunAt)
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
      const patch = toolPatch(args, checkedTimezone(args.timezone ?? task.timezone), now)
      const checked = await checkUpdate(tx, chat, task, patch, now)
      const payload: UpdatePayload = { patch, enables: checked.enabling, name: task.name }
      const row = await tx.scheduleReservation.create({
        data: {
          workspaceId: chat.workspaceId,
          ...turn,
          kind: 'update',
          scheduleId: task.id,
          payload: payload as unknown as Prisma.InputJsonValue,
        },
      })
      return reserved(
        row,
        task.id,
        { ...checked.fields, siteId: task.siteId, enabled: checked.enabled },
        checked.nextRunAt,
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
  task: (ScheduleFields & { siteId: string | null; enabled: boolean }) | null,
  nextRunAt: Date | null,
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
            siteId: task.siteId,
            enabled: task.enabled,
          },
    nextRunAt,
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
  const payload: UpdatePayload = { patch, enables: checked.enabling, name: task.name }
  const updated = await tx.scheduleReservation.update({
    where: { id: row.id },
    data: { payload: payload as unknown as Prisma.InputJsonValue },
  })
  return reserved(
    updated,
    task.id,
    { ...checked.fields, siteId: task.siteId, enabled: checked.enabled },
    checked.nextRunAt,
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
 * manages the workspace, the task is still theirs and of the chat's project, the words, the
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
      // The project of the chat: a reservation never makes a task of another one.
      if (payload.siteId !== chat.siteId) throw scheduleNotFound()
      const data = await newTaskData(
        tx,
        {
          userId: chat.authorId,
          workspaceId: chat.workspaceId,
          siteId: payload.siteId,
          name: payload.name,
          instructions: payload.instructions,
          effort: payload.effort,
          triggers: payload.triggers,
          timezone: payload.timezone,
          notify: payload.notify,
          enabled: payload.enabled,
          createdVia: 'chat',
          sourceTaskId: input.taskId,
        },
        now,
        row.createdAt,
      )
      const schedule = await tx.scheduledTask.create({ data })
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
    const { row: schedule, action } = await changeInTx(
      tx,
      task,
      updateOf(row).patch,
      now,
      row.createdAt,
    )
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
