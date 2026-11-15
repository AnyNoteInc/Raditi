import {
  reasoningEffortSchema,
  scheduledRunReasons,
  scheduledRunStateSchema,
  scheduledRunTriggers,
  schedulePausedReasons,
  scheduleTriggerListSchema,
  type AppEnv,
} from '@repo/domain'
import { z } from 'zod'

import { chatContextOf } from '../services/chat/context.ts'
import {
  createSchedule,
  defaultTimezone,
  deleteSchedule,
  listSchedules,
  projectScheduleCount,
  readSchedule,
  rememberTimezone,
  runScheduleNow,
  scheduleCostHint,
  scheduleNextRun,
  setScheduleEnabled,
  updateSchedule,
  type ScheduleChange,
} from '../services/schedule/manage.ts'
import { consentedProcedure, router, type Context } from '../trpc.ts'

// «Расписание» of the cabinet (docs/plan/82-scheduled-tasks.md, §4.5): the scheduled tasks the user
// created, the page of one with its runs, and what the window, the switch and «Запустить сейчас» do.
// Every procedure answers a task of someone else exactly as one that does not exist.

/** Bounds the body; the rules of the words are the service's, told in the client's terms. */
const name = z.string().max(400)
const instructions = z.string().max(16_000)
const timezone = z.string().min(1).max(64)
/** The shape only: «не чаще раза в час» is the service's, so the client hears it in words (Зп11). */
const triggers = scheduleTriggerListSchema

const runOutput = z.strictObject({
  id: z.uuid(),
  dueAt: z.date(),
  trigger: z.enum(scheduledRunTriggers),
  state: scheduledRunStateSchema,
  /** Its chat; null — none started, or it was deleted (Зп6, «Чат удалён»). */
  chat: z.strictObject({ id: z.uuid(), title: z.string().nullable() }).nullable(),
  createdAt: z.date(),
  startedAt: z.date().nullable(),
})

const scheduleOutput = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  instructions: z.string(),
  effort: reasoningEffortSchema,
  triggers,
  timezone: z.string(),
  enabled: z.boolean(),
  notify: z.boolean(),
  pausedReason: z.enum(schedulePausedReasons).nullable(),
  lastRefusalReason: z.enum(scheduledRunReasons).nullable(),
  nextRunAt: z.date().nullable(),
  lastRunAt: z.date().nullable(),
  createdVia: z.enum(['manual', 'template', 'chat']),
  templateSlug: z.string().nullable(),
  /** null — without a project; `deleted` — its project was deleted (Зп22): «Проект удалён». */
  project: z.strictObject({ id: z.uuid(), name: z.string(), deleted: z.boolean() }).nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
  lastRun: runOutput.nullable(),
})

const scheduleInput = z.strictObject({
  scheduleId: z.uuid(),
})

/** The environment a personal workspace is made in, from the context of chats or of billing. */
function appEnvOf(ctx: Context): AppEnv {
  const appEnv = ctx.chat?.appEnv ?? ctx.billing?.appEnv
  return appEnv ?? chatContextOf(ctx).appEnv
}

export const scheduleRouter = router({
  /** «Ваши» (Зп25): the tasks the user created, each with its latest run; and the zone of a new one. */
  list: consentedProcedure
    .output(
      z.strictObject({
        schedules: z.array(scheduleOutput),
        /** The zone a new task takes (Зп12): the user's browser's, else Moscow. */
        timezone: z.string(),
      }),
    )
    .query(async ({ ctx }) => ({
      schedules: await listSchedules(ctx.prisma, ctx.user.id),
      timezone: await defaultTimezone(ctx.prisma, ctx.user.id),
    })),

  /** The page of a task (Зп6): it and its last 50 runs, the newest first. */
  get: consentedProcedure
    .input(scheduleInput)
    .output(scheduleOutput.extend({ runs: z.array(runOutput) }))
    .query(({ ctx, input }) =>
      readSchedule(ctx.prisma, { userId: ctx.user.id, scheduleId: input.scheduleId }),
    ),

  /** «Создать» (Зп7, Зп9): `templateSlug` — the template of «Шаблоны» the window was opened with. */
  create: consentedProcedure
    .input(
      z.strictObject({
        /** null — without a project; required, so a forgotten field never gives one. */
        siteId: z.uuid().nullable(),
        name,
        instructions,
        effort: reasoningEffortSchema.optional(),
        triggers,
        timezone,
        notify: z.boolean().optional(),
        templateSlug: z.string().max(40).nullable().optional(),
      }),
    )
    .output(scheduleOutput.extend({ runs: z.array(runOutput) }))
    .mutation(({ ctx, input }) =>
      createSchedule(ctx.prisma, appEnvOf(ctx), {
        userId: ctx.user.id,
        siteId: input.siteId,
        name: input.name,
        instructions: input.instructions,
        effort: input.effort ?? 'high',
        triggers: input.triggers,
        timezone: input.timezone,
        notify: input.notify ?? true,
        templateSlug: input.templateSlug ?? null,
        now: new Date(),
      }),
    ),

  /** «Сохранить» (Зп7, Зп13): only what is given changes. */
  update: consentedProcedure
    .input(
      z.strictObject({
        scheduleId: z.uuid(),
        siteId: z.uuid().nullable().optional(),
        name: name.optional(),
        instructions: instructions.optional(),
        effort: reasoningEffortSchema.optional(),
        triggers: triggers.optional(),
        timezone: timezone.optional(),
        notify: z.boolean().optional(),
      }),
    )
    .output(scheduleOutput.extend({ runs: z.array(runOutput) }))
    .mutation(({ ctx, input }) => {
      const { scheduleId, siteId, ...fields } = input
      const change: ScheduleChange = {
        ...(siteId === undefined ? {} : { siteId }),
        ...(fields.name === undefined ? {} : { name: fields.name }),
        ...(fields.instructions === undefined ? {} : { instructions: fields.instructions }),
        ...(fields.effort === undefined ? {} : { effort: fields.effort }),
        ...(fields.triggers === undefined ? {} : { triggers: fields.triggers }),
        ...(fields.timezone === undefined ? {} : { timezone: fields.timezone }),
        ...(fields.notify === undefined ? {} : { notify: fields.notify }),
      }
      return updateSchedule(ctx.prisma, appEnvOf(ctx), {
        userId: ctx.user.id,
        scheduleId,
        change,
        now: new Date(),
      })
    }),

  /** The switch of a task (Зп5): pause, or resume from now. */
  setEnabled: consentedProcedure
    .input(z.strictObject({ scheduleId: z.uuid(), enabled: z.boolean() }))
    .output(scheduleOutput.extend({ runs: z.array(runOutput) }))
    .mutation(({ ctx, input }) =>
      setScheduleEnabled(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** «Удалить» (Зп23): the task goes, the chats of its runs stay. */
  delete: consentedProcedure
    .input(scheduleInput)
    .output(z.strictObject({ deleted: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      deleteSchedule(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** «Запустить сейчас» (Зп24): the chat of the run, which the cabinet opens. */
  runNow: consentedProcedure
    .input(scheduleInput)
    .output(z.strictObject({ taskId: z.uuid() }))
    .mutation(({ ctx, input }) =>
      runScheduleNow(ctx.prisma, chatContextOf(ctx), {
        ...input,
        userId: ctx.user.id,
        now: new Date(),
      }),
    ),

  /**
   * «Стоимость» and «Следующий запуск» of the window (Зп7, Зп30): the runs of the schedules over
   * the next 7 days, the average charge, the weekly limit of the workspace the task goes to.
   */
  costHint: consentedProcedure
    .input(z.strictObject({ siteId: z.uuid().nullable(), triggers, timezone }))
    .output(
      z.strictObject({
        averageCredits: z.number().int(),
        runsPerWeek: z.number().int().min(0),
        creditsPerWeek: z.number().int().min(0),
        weeklyLimit: z.number().int().nullable(),
        overHalf: z.boolean(),
        nextRunAt: z.date().nullable(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const now = new Date()
      return {
        ...(await scheduleCostHint(ctx.prisma, appEnvOf(ctx), {
          ...input,
          userId: ctx.user.id,
          now,
        })),
        nextRunAt: scheduleNextRun({ triggers: input.triggers, timezone: input.timezone, now }),
      }
    }),

  /** The zone of the browser, remembered when the cabinet is opened (Зп12). */
  rememberTimezone: consentedProcedure
    .input(z.strictObject({ timezone }))
    .output(z.strictObject({ timezone: z.string() }))
    .mutation(({ ctx, input }) =>
      rememberTimezone(ctx.prisma, { userId: ctx.user.id, timezone: input.timezone }),
    ),

  /** How many tasks «Удалить проект» stops (Зп22): the window of the deletion names them. */
  projectCount: consentedProcedure
    .input(z.strictObject({ siteId: z.uuid() }))
    .output(z.strictObject({ count: z.number().int().min(0) }))
    .query(({ ctx, input }) =>
      projectScheduleCount(ctx.prisma, { userId: ctx.user.id, siteId: input.siteId }),
    ),
})
