import {
  isScheduleTooOftenIssue,
  reasoningEffortSchema,
  scheduleCreateArgumentsSchema,
  scheduleDeleteArgumentsSchema,
  scheduleInstructionsSchema,
  scheduleLimits,
  scheduleListArgumentsSchema,
  scheduleNameSchema,
  scheduleTimezoneSchema,
  scheduleToolProjects,
  scheduleToolTriggerSchema,
  scheduleUpdateArgumentsSchema,
} from '@repo/domain'
import { z } from 'zod'

/**
 * The `schedule` tools as the model's tools declare them (docs/plan/82-scheduled-tasks.md,
 * Зп31–Зп34): the fields of the domain's strict schemas, each described for the model, refined
 * against those schemas. One rule of the domain is left to the tool itself — runs closer than an
 * hour (`SCHEDULE_TOO_OFTEN`): a schedule the client may still change, which the agent hears as a
 * result it can explain (Зп33), not a request the role refuses as a whole.
 */

/** The domain's own schema passes, or fails only for runs closer than an hour. */
export function scheduleArgumentsAdmitted(schema: z.ZodType, args: unknown): boolean {
  const parsed = schema.safeParse(args)
  return parsed.success || parsed.error.issues.every(isScheduleTooOftenIssue)
}

const id = z.uuid()

const triggers = z
  .array(scheduleToolTriggerSchema)
  .max(scheduleLimits.triggersPerTask)
  .describe(
    'When it runs, up to five schedules on the wall clock of the timezone: {kind:"daily",time:"09:00"}, {kind:"weekdays",time:"08:00"} (Monday to Friday), {kind:"weekly",time:"16:00",days:[5]} (ISO days, 1 = Monday … 7 = Sunday, ascending), {kind:"monthly",time:"10:00",day:1} (the last day in a shorter month), {kind:"hourly",minute:15} (alone), {kind:"once",date:"2026-11-20",time:"09:00"} or {kind:"once",inMinutes:30} — from now, the server counts the moment. [] — only by hand. Runs of one task are at least an hour apart.',
  )
const name = scheduleNameSchema.describe(
  'A short name the client agreed to, one line without a date, e.g. «Проверка сайта»',
)
const instructions = scheduleInstructionsSchema.describe(
  "What the agent does at each run, written as the client's own request in their words — no schedule, no date and no time inside it — exactly as the client agreed to it",
)
const effort = reasoningEffortSchema.describe(
  '«Размышление» of each run: low, high (default) or max',
)
const timezone = scheduleTimezoneSchema.describe(
  'An IANA zone, e.g. Europe/Moscow; without it — the zone schedule_list gives',
)
const notify = z
  .boolean()
  .describe('Notify the client when a run is done or has changes ready; default true')
const confirmedByClient = z
  .literal(true)
  .describe(
    'The client agreed in this chat, in their own words, to exactly what you recapped: the name, the instructions, the project, «Размышление» and the schedule with its timezone',
  )
const target = {
  scheduleId: id.optional().describe('A task of schedule_list'),
  reservedId: id.optional().describe('A change this turn reserved: reservedId of its answer'),
}

export const scheduleListToolArgumentsSchema = scheduleListArgumentsSchema

export const scheduleCreateToolArgumentsSchema = z
  .strictObject({
    name,
    instructions,
    project: z
      .enum(scheduleToolProjects)
      .describe(
        'this_chat — the project of this chat, only in a chat of a project; none — only in a chat without a project',
      ),
    effort: effort.optional(),
    triggers,
    timezone: timezone.optional(),
    notify: notify.optional(),
    confirmedByClient,
  })
  .refine((args) => scheduleArgumentsAdmitted(scheduleCreateArgumentsSchema, args), {
    message: 'give name, instructions, project, triggers and confirmedByClient: true',
  })

export const scheduleUpdateToolArgumentsSchema = z
  .strictObject({
    ...target,
    name: name.optional(),
    instructions: instructions.optional(),
    effort: effort.optional(),
    triggers: triggers.optional(),
    timezone: timezone.optional(),
    notify: notify.optional(),
    enabled: z.boolean().optional().describe('false pauses the task, true resumes it'),
    confirmedByClient,
  })
  .refine((args) => scheduleArgumentsAdmitted(scheduleUpdateArgumentsSchema, args), {
    message:
      'give scheduleId or reservedId, one of the two, what changes and confirmedByClient: true',
  })

export const scheduleDeleteToolArgumentsSchema = z
  .strictObject({ ...target, confirmedByClient })
  .refine((args) => scheduleArgumentsAdmitted(scheduleDeleteArgumentsSchema, args), {
    message: 'give scheduleId or reservedId, one of the two, and confirmedByClient: true',
  })

// The domain's own rules, for the body check of the role (mcp-policy) and the service.
export {
  scheduleCreateArgumentsSchema,
  scheduleDeleteArgumentsSchema,
  scheduleListArgumentsSchema,
  scheduleUpdateArgumentsSchema,
}
