import { z } from 'zod'

import { badRequest } from '../errors.ts'
import { reasoningEffortSchema } from '../llm/model-class.ts'
import { MINUTE_MS, wallOf } from './calendar.ts'
import { scheduleInstructionsSchema, scheduleNameSchema } from './fields.ts'
import { SCHEDULE_MIN_GAP_MINUTES, scheduleLimits } from './limits.ts'
import {
  SCHEDULE_TOO_OFTEN,
  SCHEDULE_TOO_OFTEN_TEXT,
  scheduleTimezoneSchema,
  scheduleRunsTooOften,
  scheduleTriggerSchema,
  type ScheduleTrigger,
} from './triggers.ts'

/**
 * The arguments of the `schedule` tools of the mcp role (docs/plan/82-scheduled-tasks.md, Зп31–Зп34),
 * as the model sends them; the policy of the role parses them too. Strict objects: an unknown key
 * is a refusal, not a guess. Who changes what — the workspace and the author — comes from the
 * admission of the call, never from here (Зп44, Зп54).
 */

/** «Один раз» from now (Зп15): the server counts the moment, not the model. */
export const scheduleToolOnceSchema = z.strictObject({
  kind: z.literal('once'),
  inMinutes: z.number().int().min(scheduleLimits.onceMinMinutes).max(scheduleLimits.onceMaxMinutes),
})
export type ScheduleToolOnce = z.infer<typeof scheduleToolOnceSchema>

/** A schedule as the tools take it: one of the window's, or a single run some minutes from now. */
export const scheduleToolTriggerSchema = z.union([scheduleTriggerSchema, scheduleToolOnceSchema])
export type ScheduleToolTrigger = z.infer<typeof scheduleToolTriggerSchema>

const isRelative = (trigger: ScheduleToolTrigger): trigger is ScheduleToolOnce =>
  'inMinutes' in trigger

/**
 * The schedules of a tool call: what is known without the clock is checked here — «Каждый час»
 * alone, the window's schedules an hour apart, the single runs from now an hour apart. A single
 * run from now against the others is checked when the server has counted it.
 */
export const scheduleToolTriggersSchema = z
  .array(scheduleToolTriggerSchema)
  .max(scheduleLimits.triggersPerTask)
  .superRefine((triggers, ctx) => {
    const relative = triggers.filter(isRelative).map((trigger) => trigger.inMinutes)
    const absolute = triggers.filter((trigger): trigger is ScheduleTrigger => !isRelative(trigger))
    const hourly = absolute.some((trigger) => trigger.kind === 'hourly')
    const closeRelative = relative.some((minutes, index) =>
      relative.some(
        (other, at) => at > index && Math.abs(other - minutes) < SCHEDULE_MIN_GAP_MINUTES,
      ),
    )
    if ((hourly && triggers.length > 1) || scheduleRunsTooOften(absolute) || closeRelative)
      ctx.addIssue({
        code: 'custom',
        message: SCHEDULE_TOO_OFTEN_TEXT,
        params: { code: SCHEDULE_TOO_OFTEN },
      })
  })

/**
 * The single runs from now as dates and times of the task's zone, rounded up to the minute: what
 * is stored is the moment ready (Зп15). In the hour the clocks repeat, the wall clock stored means
 * its earlier moment, which the tick then runs at once.
 */
export function resolveScheduleToolTriggers(
  triggers: readonly ScheduleToolTrigger[],
  timezone: string,
  now: Date,
): ScheduleTrigger[] {
  const base = now.getTime()
  if (!Number.isFinite(base)) throw badRequest('Invalid moment of a scheduled task')
  return triggers.map((trigger) => {
    if (!isRelative(trigger)) return trigger
    const at = Math.ceil((base + trigger.inMinutes * MINUTE_MS) / MINUTE_MS) * MINUTE_MS
    const wall = wallOf(at, timezone)
    const pad = (value: number) => String(value).padStart(2, '0')
    return {
      kind: 'once',
      date: `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`,
      time: `${pad(wall.hour)}:${pad(wall.minute)}`,
    }
  })
}

const id = z.uuid()

/** `schedule_list`: the author's own tasks, the time and the zone of the client (Зп54). */
export const scheduleListArgumentsSchema = z.strictObject({})

/**
 * Where a task set up in a chat goes (docs/plan/84-projects.md, ПР19): `this_chat` — the project of
 * the chat, `none` — no project; left out — as the chat is. A chat of a project sets up tasks of
 * it, a chat without one tasks without one: the other value is refused.
 */
export const scheduleToolProjects = ['this_chat', 'none'] as const
export type ScheduleToolProject = (typeof scheduleToolProjects)[number]

/** `schedule_create`: a new task, once the client confirmed its name, words and schedule (Зп34). */
export const scheduleCreateArgumentsSchema = z.strictObject({
  name: scheduleNameSchema,
  instructions: scheduleInstructionsSchema,
  effort: reasoningEffortSchema.optional(),
  triggers: scheduleToolTriggersSchema,
  timezone: scheduleTimezoneSchema.optional(),
  notify: z.boolean().optional(),
  project: z.enum(scheduleToolProjects).optional(),
  confirmedByClient: z.literal(true),
})
export type ScheduleCreateArguments = z.infer<typeof scheduleCreateArgumentsSchema>

const exactlyOneTarget = (args: {
  scheduleId?: string | undefined
  reservedId?: string | undefined
}) => (args.scheduleId === undefined) !== (args.reservedId === undefined)
const TARGET_MESSAGE = 'give scheduleId of schedule_list or reservedId of this turn, one of the two'

/**
 * `schedule_update`: a task of `schedule_list`, or a change this turn reserved (Зп33); `enabled`
 * pauses and resumes it.
 */
export const scheduleUpdateArgumentsSchema = z
  .strictObject({
    scheduleId: id.optional(),
    reservedId: id.optional(),
    name: scheduleNameSchema.optional(),
    instructions: scheduleInstructionsSchema.optional(),
    effort: reasoningEffortSchema.optional(),
    triggers: scheduleToolTriggersSchema.optional(),
    timezone: scheduleTimezoneSchema.optional(),
    notify: z.boolean().optional(),
    enabled: z.boolean().optional(),
    confirmedByClient: z.literal(true),
  })
  .refine(exactlyOneTarget, TARGET_MESSAGE)
  .refine(
    (args) =>
      args.name !== undefined ||
      args.instructions !== undefined ||
      args.effort !== undefined ||
      args.triggers !== undefined ||
      args.timezone !== undefined ||
      args.notify !== undefined ||
      args.enabled !== undefined,
    'say what changes',
  )
export type ScheduleUpdateArguments = z.infer<typeof scheduleUpdateArgumentsSchema>

/** `schedule_delete`: a task of `schedule_list`, or a change this turn reserved. */
export const scheduleDeleteArgumentsSchema = z
  .strictObject({
    scheduleId: id.optional(),
    reservedId: id.optional(),
    confirmedByClient: z.literal(true),
  })
  .refine(exactlyOneTarget, TARGET_MESSAGE)
export type ScheduleDeleteArguments = z.infer<typeof scheduleDeleteArgumentsSchema>

/** The names of the tools as the role declares them (the model sees `raditi_<name>`). */
export const scheduleToolNames = [
  'schedule_list',
  'schedule_create',
  'schedule_update',
  'schedule_delete',
] as const
export type ScheduleToolName = (typeof scheduleToolNames)[number]

/** The tools that change tasks: not declared and refused in a pass without the client (Зп32). */
export const scheduleChangingToolNames = [
  'schedule_create',
  'schedule_update',
  'schedule_delete',
] as const satisfies readonly ScheduleToolName[]

export const scheduleToolArgumentSchemas = {
  schedule_list: scheduleListArgumentsSchema,
  schedule_create: scheduleCreateArgumentsSchema,
  schedule_update: scheduleUpdateArgumentsSchema,
  schedule_delete: scheduleDeleteArgumentsSchema,
} as const satisfies Record<ScheduleToolName, z.ZodType>
