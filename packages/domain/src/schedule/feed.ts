import { z } from 'zod'

import { reasoningEffortSchema } from '../llm/model-class.ts'
import { looksLikeSecret } from '../tasks/client-feed-text.ts'
import { scheduleInstructionsSchema, scheduleNameSchema } from './fields.ts'
import { scheduleTimezoneSchema, scheduleTriggersSchema } from './triggers.ts'

/**
 * The feed rows of the scheduled tasks (docs/plan/82-scheduled-tasks.md, Зп33, Зп35): core writes
 * them at the end of a turn, when it applied — or refused — what the agent reserved with the
 * `schedule` tools. The card reads the task again by tRPC; the row keeps what it was then.
 */

const version = z.literal(1)

/** What came of a change of a task: the card's title says it (Зп35). */
export const scheduleChangeActions = ['created', 'updated', 'paused', 'resumed', 'deleted'] as const
export type ScheduleChangeAction = (typeof scheduleChangeActions)[number]

/** What the agent asked for, of a change that did not come true. */
export const scheduleLeftActions = ['create', 'update', 'delete'] as const
export type ScheduleLeftAction = (typeof scheduleLeftActions)[number]

/**
 * Why it did not: no rights in the workspace, the limit of enabled tasks, no such task any more,
 * a password or a key in the words, a schedule that does not fit (too often, in the past), or the
 * answer of the agent broke off.
 */
export const scheduleLeftReasons = [
  'forbidden',
  'limit',
  'not_found',
  'text_refused',
  'name_refused',
  'invalid',
  'failed',
] as const
export type ScheduleLeftReason = (typeof scheduleLeftReasons)[number]

// The words of the task as core checked them; a backstop for a writer that forgot the check.
const name = scheduleNameSchema.refine((text) => !looksLikeSecret(text), 'looks like a key')
const instructions = scheduleInstructionsSchema.refine(
  (text) => !looksLikeSecret(text),
  'looks like a password or a key',
)

/** `feed.schedule_change` v1 — a task of the chat's author created, changed, paused, resumed or deleted. */
export const feedScheduleChangePayloadSchema = z.strictObject({
  v: version,
  action: z.enum(scheduleChangeActions),
  scheduleId: z.uuid(),
  name,
  instructions,
  triggers: scheduleTriggersSchema,
  timezone: scheduleTimezoneSchema,
  /** The next run then; null — paused, deleted, or only by hand. */
  nextRunAt: z.iso.datetime().nullable(),
  /** The project of the task; null — none. */
  siteId: z.uuid().nullable(),
  effort: reasoningEffortSchema,
  notify: z.boolean(),
})
export type FeedScheduleChangePayload = z.infer<typeof feedScheduleChangePayloadSchema>

/** `feed.schedule_left` v1 — a change the agent reserved did not come true. */
export const feedScheduleLeftPayloadSchema = z.strictObject({
  v: version,
  action: z.enum(scheduleLeftActions),
  /** The name the agent gave or the task had; null — none to tell (it may be what was refused). */
  name: name.nullable(),
  reason: z.enum(scheduleLeftReasons),
})
export type FeedScheduleLeftPayload = z.infer<typeof feedScheduleLeftPayloadSchema>
