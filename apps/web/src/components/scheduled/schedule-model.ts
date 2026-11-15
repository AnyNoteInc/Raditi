import type { ReasoningEffort } from '@repo/domain/llm/model-class'
import {
  hasScheduleTemplatePlaceholder,
  nextRunOf,
  runDateText,
  runMomentText,
  SCHEDULE_TOO_OFTEN_TEXT,
  scheduledRunStateText,
  scheduleInPast,
  scheduleLimits,
  schedulePausedReasonText,
  scheduleTemplatePlaceholder,
  scheduleText,
  scheduleTriggersInPast,
  scheduleTriggersSchema,
  timezoneSuffix,
  type ScheduleTemplate,
  type ScheduleTrigger,
  type ScheduleTriggerKind,
} from '@repo/domain/schedule'
import type { AppRouter } from '@repo/trpc'
import type { inferRouterOutputs } from '@trpc/server'

import {
  scheduleChatDraft,
  scheduleDialogTexts,
  scheduleRowTexts,
  schedulePageTexts,
} from './schedule-texts'

// What «Запланированные задачи» shows and checks, without React (docs/plan/82-scheduled-tasks.md,
// Зп3, Зп5–Зп8, Зп10, Зп15): the filters, the order and the search of «Ваши», the lines of a row,
// the runs of a task with its missed ones together, and the fields of the window.

type Outputs = inferRouterOutputs<AppRouter>

/** A task of «Ваши», with its latest run. */
export type ScheduleItem = Outputs['schedule']['list']['schedules'][number]
/** A task and its last 50 runs: its page, and what a change answers. */
export type ScheduleDetail = Outputs['schedule']['get']
export type ScheduleRun = ScheduleDetail['runs'][number]
export type ScheduleCost = Outputs['schedule']['costHint']

// ---------------------------------------------------------------------------------------------
// «Ваши»: filters, order, search
// ---------------------------------------------------------------------------------------------

export const scheduleTags = ['all', 'enabled', 'paused', 'completed', 'failed'] as const
export type ScheduleTag = (typeof scheduleTags)[number]

/** The last run did not succeed (Зп3, «С ошибкой»): it failed, did not start or stopped. */
export const lastRunFailed = (item: ScheduleItem): boolean =>
  item.lastRun !== null && ['failed', 'refused', 'stopped'].includes(item.lastRun.state.kind)

export function inScheduleTag(item: ScheduleItem, tag: ScheduleTag): boolean {
  switch (tag) {
    case 'all':
      return true
    case 'enabled':
      return item.enabled
    case 'paused':
      return !item.enabled && item.pausedReason !== 'completed'
    case 'completed':
      return item.pausedReason === 'completed'
    case 'failed':
      return lastRunFailed(item)
  }
}

/** The projects the tasks are in, in the order they first come; null — «Без проекта». */
export function projectsOfSchedules(
  items: readonly ScheduleItem[],
): { id: string | null; name: string | null }[] {
  const seen = new Map<string | null, string | null>()
  for (const item of items) seen.set(item.project?.id ?? null, item.project?.name ?? null)
  return [...seen].map(([id, name]) => ({ id, name }))
}

export const inProject = (item: ScheduleItem, project: string | null | 'all'): boolean =>
  project === 'all' || (item.project?.id ?? null) === project

/** By name and by instructions (Зп3). */
export function matchesSearch(item: ScheduleItem, query: string): boolean {
  const words = query.trim().toLocaleLowerCase('ru')
  if (words === '') return true
  return `${item.name}\n${item.instructions}`.toLocaleLowerCase('ru').includes(words)
}

export const scheduleOrders = ['next', 'name', 'newest'] as const
export type ScheduleOrder = (typeof scheduleOrders)[number]

const byName = (a: ScheduleItem, b: ScheduleItem) => a.name.localeCompare(b.name, 'ru')

/** The order of «Ваши» (Зп3): the nearest run first, tasks without one after them by name. */
export function sortSchedules(
  items: readonly ScheduleItem[],
  order: ScheduleOrder,
): ScheduleItem[] {
  const sorted = [...items]
  if (order === 'name') return sorted.sort(byName)
  if (order === 'newest')
    return sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return sorted.sort((a, b) => {
    const at = a.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY
    const bt = b.nextRunAt?.getTime() ?? Number.POSITIVE_INFINITY
    return at === bt ? byName(a, b) : at - bt
  })
}

// ---------------------------------------------------------------------------------------------
// The lines of a task
// ---------------------------------------------------------------------------------------------

/**
 * A moment as the window and the row say it: «сегодня, 15 ноября, в 9:00», «завтра, 16 ноября, в
 * 9:00», «пятница, 20 ноября, в 16:00» (Зп7) — the date beside «сегодня» and «завтра» too.
 */
export function nextRunText(at: Date, timezone: string, now: Date): string {
  const moment = runMomentText(at, timezone, now)
  const near = /^(сегодня|завтра) в (.+)$/.exec(moment)
  return near ? `${near[1]}, ${runDateText(at, timezone, now)}, в ${near[2]}` : moment
}

/**
 * The state of a task (Зп5): its next run, «На паузе», «Завершена 20 ноября», or why it stopped by
 * itself; a task only by hand — that.
 */
export function scheduleStateText(item: ScheduleDetail | ScheduleItem, now: Date): string {
  if (item.enabled)
    return item.nextRunAt === null
      ? scheduleRowTexts.manualOnly
      : scheduleRowTexts.next(
          `${runMomentText(item.nextRunAt, item.timezone, now)}${timezoneSuffix(item.timezone)}`,
        )
  if (item.pausedReason === null) return scheduleRowTexts.paused
  if (item.pausedReason === 'completed')
    return scheduleRowTexts.completed(
      runDateText(item.lastRunAt ?? item.updatedAt, item.timezone, now),
    )
  return schedulePausedReasonText[item.pausedReason]
}

/** The latest run in a line (Зп5): «Выполнена · сегодня в 9:00»; null — none yet. */
export function lastRunText(item: ScheduleItem, now: Date): string | null {
  const run = item.lastRun
  if (run === null) return null
  return `${scheduledRunStateText(run.state)} · ${runMomentText(run.dueAt, item.timezone, now)}`
}

/** The schedules in words, with the zone when it is not Moscow. */
export const scheduleWords = (item: { triggers: ScheduleTrigger[]; timezone: string }): string =>
  scheduleText(item.triggers, item.timezone)

// ---------------------------------------------------------------------------------------------
// The runs of a task (Зп6)
// ---------------------------------------------------------------------------------------------

/** One line of the runs: a run, or missed runs in a row as one line. */
export type RunLine =
  | { kind: 'run'; run: ScheduleRun }
  | { kind: 'missed'; key: string; from: Date; to: Date; runs: ScheduleRun[] }

const isMissed = (run: ScheduleRun) => run.state.kind === 'skipped' && run.state.reason === 'missed'

/** The last of `count` moments of the schedules from `from` on: the end of a row of missed runs. */
function lastOfMissed(
  from: Date,
  count: number,
  triggers: readonly ScheduleTrigger[],
  timezone: string,
): Date {
  let at = from
  for (let index = 1; index < count; index += 1) {
    const next = nextRunOf(triggers, timezone, at)
    if (next === null) break
    at = next
  }
  return at
}

/**
 * The runs, the newest first, with missed runs next to each other as one line — «Пропущены запуски
 * с 9:00 по 14:00» (Зп6). A row of «missed» stands for `missedCount` moments from its own.
 */
export function runLines(
  runs: readonly ScheduleRun[],
  triggers: readonly ScheduleTrigger[],
  timezone: string,
): RunLine[] {
  const lines: RunLine[] = []
  for (const run of runs) {
    if (!isMissed(run)) {
      lines.push({ kind: 'run', run })
      continue
    }
    const count = run.state.kind === 'skipped' ? Math.max(1, run.state.missedCount) : 1
    const to = lastOfMissed(run.dueAt, count, triggers, timezone)
    const last = lines.at(-1)
    // Newest first: the earlier missed run widens the line downwards.
    if (last?.kind === 'missed') {
      last.from = run.dueAt
      last.runs.push(run)
    } else lines.push({ kind: 'missed', key: run.id, from: run.dueAt, to, runs: [run] })
  }
  return lines
}

/** A moment of a run by its clock alone, «9:00». */
const clockOf = (at: Date, timezone: string): string =>
  new Intl.DateTimeFormat('ru-RU', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at)

/**
 * The words of a line of missed runs (Зп6): «Пропущены запуски с 9:00 по 14:00» within a day,
 * «… с 14 ноября, 23:00 по 15 ноября, 2:00» across days; one moment — «Пропущено».
 */
export function missedText(
  line: Extract<RunLine, { kind: 'missed' }>,
  timezone: string,
  now: Date,
): string {
  const first = line.runs[0]
  if (line.from.getTime() === line.to.getTime() && first !== undefined)
    return scheduledRunStateText(first.state)
  const fromDay = runDateText(line.from, timezone, now)
  const toDay = runDateText(line.to, timezone, now)
  const from = clockOf(line.from, timezone)
  const to = clockOf(line.to, timezone)
  return fromDay === toDay
    ? schedulePageTexts.missedRange(from, to)
    : schedulePageTexts.missedRange(`${fromDay}, ${from}`, `${toDay}, ${to}`)
}

// ---------------------------------------------------------------------------------------------
// The window (Зп7, Зп8)
// ---------------------------------------------------------------------------------------------

/** A frequency of the window: a kind of schedule, or «Только вручную». */
export type ScheduleFrequency = ScheduleTriggerKind | 'manual'

/** The frequencies in the order of the list (Зп8). */
export const scheduleFrequencies: readonly ScheduleFrequency[] = [
  'once',
  'hourly',
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'manual',
]

/** One block of «Когда запускать»: every field of every frequency, so a switch keeps the time. */
export interface TriggerDraft {
  key: string
  frequency: ScheduleFrequency
  time: string
  date: string
  minute: number
  days: number[]
  day: number
}

export interface ScheduleForm {
  name: string
  instructions: string
  /** null — «Без проекта». */
  siteId: string | null
  effort: ReasoningEffort
  triggers: TriggerDraft[]
  timezone: string
  notify: boolean
  /** The template of «Шаблоны» the window was opened with; null — by hand. */
  templateSlug: string | null
}

let keys = 0
const nextKey = () => `trigger-${(keys += 1)}`

const wallParts = (at: Date, timezone: string) => {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  )
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  }
}

/** Today on the wall clock of the zone: the earliest date of «Один раз». */
export const wallDateOf = (at: Date, timezone: string): string => wallParts(at, timezone).date

/** The date of «Один раз» for a time: today while it is ahead, else tomorrow. */
export function onceDateFor(time: string, timezone: string, now: Date): string {
  const wall = wallParts(now, timezone)
  if (time > wall.time) return wall.date
  return wallParts(new Date(now.getTime() + 24 * 60 * 60 * 1000), timezone).date
}

/** A new block: every day at 9:00. */
export function newTriggerDraft(timezone: string, now: Date): TriggerDraft {
  return {
    key: nextKey(),
    frequency: 'daily',
    time: '09:00',
    date: onceDateFor('09:00', timezone, now),
    minute: 0,
    days: [1],
    day: 1,
  }
}

export function draftOfTrigger(
  trigger: ScheduleTrigger,
  timezone: string,
  now: Date,
): TriggerDraft {
  const draft = { ...newTriggerDraft(timezone, now), frequency: trigger.kind }
  switch (trigger.kind) {
    case 'once':
      return { ...draft, date: trigger.date, time: trigger.time }
    case 'hourly':
      return { ...draft, minute: trigger.minute }
    case 'daily':
    case 'weekdays':
      return { ...draft, time: trigger.time }
    case 'weekly':
      return { ...draft, time: trigger.time, days: [...trigger.days] }
    case 'monthly':
      return { ...draft, time: trigger.time, day: trigger.day }
  }
}

/** The schedule of a block; null — «Только вручную». */
export function triggerOfDraft(draft: TriggerDraft): ScheduleTrigger | null {
  switch (draft.frequency) {
    case 'manual':
      return null
    case 'once':
      return { kind: 'once', date: draft.date, time: draft.time }
    case 'hourly':
      return { kind: 'hourly', minute: draft.minute }
    case 'daily':
      return { kind: 'daily', time: draft.time }
    case 'weekdays':
      return { kind: 'weekdays', time: draft.time }
    case 'weekly':
      return { kind: 'weekly', time: draft.time, days: [...draft.days].sort((a, b) => a - b) }
    case 'monthly':
      return { kind: 'monthly', time: draft.time, day: draft.day }
  }
}

/** The schedules of the window: «Только вручную» is none; a block without its days is left out. */
export function triggersOfForm(form: Pick<ScheduleForm, 'triggers'>): ScheduleTrigger[] {
  return form.triggers
    .filter((draft) => draft.frequency !== 'weekly' || draft.days.length > 0)
    .map(triggerOfDraft)
    .filter((trigger) => trigger !== null)
}

/** A block may offer «Каждый час» and «Только вручную» only alone (Зп11). */
export const frequenciesOf = (blocks: number): readonly ScheduleFrequency[] =>
  blocks > 1
    ? scheduleFrequencies.filter((each) => each !== 'hourly' && each !== 'manual')
    : scheduleFrequencies

/** «+ Добавить время»: up to five, and not beside «Каждый час» or «Только вручную». */
export const canAddTrigger = (form: Pick<ScheduleForm, 'triggers'>): boolean =>
  form.triggers.length < scheduleLimits.triggersPerTask &&
  !form.triggers.some((draft) => draft.frequency === 'hourly' || draft.frequency === 'manual')

export function newScheduleForm(
  timezone: string,
  now: Date,
  effort: ReasoningEffort,
): ScheduleForm {
  return {
    name: '',
    instructions: '',
    siteId: null,
    effort,
    triggers: [newTriggerDraft(timezone, now)],
    timezone,
    notify: true,
    templateSlug: null,
  }
}

const manualDraft = (timezone: string, now: Date): TriggerDraft => ({
  ...newTriggerDraft(timezone, now),
  frequency: 'manual',
})

/** The window of a template (Зп9): its fields; a template about a site takes the only project. */
export function formOfTemplate(
  template: ScheduleTemplate,
  timezone: string,
  now: Date,
  onlyProject: string | null,
): ScheduleForm {
  return {
    name: template.name,
    instructions: template.instructions,
    siteId: template.project === 'none' ? null : onlyProject,
    effort: template.effort,
    triggers:
      template.triggers.length === 0
        ? [manualDraft(timezone, now)]
        : template.triggers.map((trigger) => draftOfTrigger(trigger, timezone, now)),
    timezone,
    notify: true,
    templateSlug: template.slug,
  }
}

/** The window of a task to change. */
export function formOfSchedule(schedule: ScheduleDetail | ScheduleItem, now: Date): ScheduleForm {
  return {
    name: schedule.name,
    instructions: schedule.instructions,
    siteId: schedule.project?.id ?? null,
    effort: schedule.effort,
    triggers:
      schedule.triggers.length === 0
        ? [manualDraft(schedule.timezone, now)]
        : schedule.triggers.map((trigger) => draftOfTrigger(trigger, schedule.timezone, now)),
    timezone: schedule.timezone,
    notify: schedule.notify,
    templateSlug: schedule.templateSlug,
  }
}

/** What the window says is wrong, by field; the server's refusals come on top of these. */
export interface FormProblems {
  name?: string
  instructions?: string
  project?: string
  /** By the key of a block. */
  triggers: Record<string, string>
  /** Of the schedules together: «не чаще раза в час». */
  schedule?: string
}

/**
 * What stops «Создать» (Зп8, Зп9, Зп11, Зп15): what is always told — a single run in the past, runs
 * closer than an hour, a week without its days, a template about a site without one — and, once
 * the client tried to save, the empty name and instructions and the place for the addresses.
 */
export function formProblems(
  form: ScheduleForm,
  now: Date,
  options: { submitted: boolean; templateNeedsProject: boolean },
): FormProblems {
  const problems: FormProblems = { triggers: {} }
  if (options.submitted && form.name.trim() === '') problems.name = scheduleDialogTexts.nameRequired
  if (options.submitted && form.instructions.trim() === '')
    problems.instructions = scheduleDialogTexts.instructionsRequired
  else if (options.submitted && hasScheduleTemplatePlaceholder(form.instructions))
    problems.instructions = scheduleTemplatePlaceholder().message
  if (options.templateNeedsProject && form.siteId === null)
    problems.project = scheduleDialogTexts.needsProject
  for (const draft of form.triggers) {
    if (draft.frequency === 'weekly' && draft.days.length === 0)
      problems.triggers[draft.key] = scheduleDialogTexts.daysRequired
    const trigger = triggerOfDraft(draft)
    if (trigger?.kind === 'once' && scheduleTriggersInPast([trigger], form.timezone, now))
      problems.triggers[draft.key] = scheduleInPast().message
  }
  if (!scheduleTriggersSchema.safeParse(triggersOfForm(form)).success)
    problems.schedule = SCHEDULE_TOO_OFTEN_TEXT
  return problems
}

export const hasProblems = (problems: FormProblems): boolean =>
  problems.name !== undefined ||
  problems.instructions !== undefined ||
  problems.project !== undefined ||
  problems.schedule !== undefined ||
  Object.keys(problems.triggers).length > 0

/** «Следующий запуск» of the window, from the client's clock (Зп7); null — none ahead. */
export function formNextRun(form: ScheduleForm, now: Date): Date | null {
  const triggers = triggersOfForm(form)
  if (!scheduleTriggersSchema.safeParse(triggers).success) return null
  return nextRunOf(triggers, form.timezone, now)
}

/**
 * The words a new chat starts with, to set the task up with the agent (Зп10): «Помогите настроить
 * запланированную задачу», and what the window already holds — «…«<название>»: <инструкция>;
 * <расписание>». The client sends them.
 */
export function chatDraftOf(form: ScheduleForm | null): string {
  if (form === null) return scheduleChatDraft.start
  const name = form.name.trim()
  const instructions = form.instructions.trim()
  const triggers = triggersOfForm(form)
  const schedule = triggers.length === 0 ? '' : scheduleText(triggers, form.timezone)
  if (name === '' && instructions === '') return scheduleChatDraft.start
  const head = name === '' ? scheduleChatDraft.start : `${scheduleChatDraft.start} «${name}»`
  const body = [instructions, schedule].filter((part) => part !== '').join('; ')
  return body === '' ? head : `${head}: ${body}`
}
