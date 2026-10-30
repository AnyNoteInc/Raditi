import {
  chatCommandIds,
  chatCommandRefusals,
  FEED_REQUEST_TEXT_LIMIT,
  feedCursorSchema,
  feedEventIdSchema,
  feedTaskHeadSchema,
  previewStatuses,
  reasoningEffortSchema,
  releaseOutcomes,
  releaseStatuses,
  taskModes,
  taskRequirementsSchema,
  taskStatuses,
  type FeedItem,
} from '@repo/domain'
import { z } from 'zod'

import { activityEventSchema, readTurnActivity } from '../services/chat/activity.ts'
import { attachmentIdsSchema } from '../services/chat/attachments.ts'
import { feedBrowserOutput } from '../services/chat/browser.ts'
import { chatContextOf } from '../services/chat/context.ts'
import { DIALOG_CURSOR_PATTERN, listDialogs } from '../services/chat/dialog-list.ts'
import { readDialogFeed, readDialogHead } from '../services/chat/feed.ts'
import { removeDialog, renameDialog, setDialogEffort } from '../services/chat/dialog-manage.ts'
import { dialogCommands, dialogFacts } from '../services/chat/dialog-facts.ts'
import { accessibleTask, taskNotFound } from '../services/chat/access.ts'
import {
  cancelDialog,
  continueDialog,
  createDialog,
  postDialogMessage,
  resumeDialog,
  retryDialog,
} from '../services/chat/tasks.ts'
import { consentedProcedure, router } from '../trpc.ts'

// The procedures of a dialog (docs/plan/53-chat-preview-release.md, «Маршруты»; the feed design,
// «Три писателя» and «Чтение по идентификатору»). A dialog is a task: every procedure answers a
// task of someone else exactly as one that does not exist.

/** Ids invented by the browser are compared as PostgreSQL prints them. */
const browserId = z.uuid().transform((id) => id.toLowerCase())
/** Bounds the body; the length the feed stores is checked after trimming, in the client's words. */
const words = z.string().max(FEED_REQUEST_TEXT_LIMIT * 4)

const postedOutput = z.strictObject({
  requestEventId: z.string(),
  repeated: z.boolean(),
})

export const commandsOutput = z.array(
  z.strictObject({
    id: z.enum(chatCommandIds),
    available: z.boolean(),
    refusal: z.enum(chatCommandRefusals).nullable(),
  }),
)

const countsOutput = z
  .strictObject({
    files: z.strictObject({ added: z.number(), modified: z.number(), deleted: z.number() }),
    media: z.number(),
    records: z.number(),
  })
  .nullable()

/** A row of the feed as `readFeedRow` gave it: its shape is the domain's, checked on reading. */
const feedItem = z.custom<FeedItem>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { type?: unknown }).type === 'string',
)

const releaseOutput = z.strictObject({
  id: z.uuid(),
  status: z.enum(releaseStatuses),
  step: z.string().nullable(),
  version: z.string(),
  outcome: z.enum(releaseOutcomes).nullable(),
})

const feedOutput = z.strictObject({
  task: feedTaskHeadSchema,
  /**
   * The cloud browser of a task in the browser (docs/plan/57-browser-tasks.md, Б12–Б18): its
   * latest session — who drives it, what the agent asked the client to do there, why it closed;
   * null for a task with the repository, or before the first pass opened one.
   */
  browser: feedBrowserOutput,
  preview: z
    .strictObject({
      status: z.enum(previewStatuses),
      unavailableReason: z.string().nullable(),
      origin: z.string().nullable(),
      revision: z.number().int(),
      dirty: z.boolean(),
    })
    .nullable(),
  candidate: z
    .strictObject({
      id: z.uuid(),
      revision: z.number().int(),
      status: z.enum(['current', 'stale']),
      counts: countsOutput,
      proposedVersion: z.string(),
      checks: z.strictObject({
        pending: z.number().int(),
        passed: z.number().int(),
        failed: z.number().int(),
        stale: z.number().int(),
      }),
    })
    .nullable(),
  release: releaseOutput.nullable(),
  /**
   * «Отменить выпуск» (docs/plan/53, «Отмена выпуска»): the latest installed release of the
   * dialog, until when it may be undone (null — the site runs another version), and its latest
   * undo; null — the dialog installed nothing.
   */
  undo: z
    .strictObject({
      releaseId: z.uuid(),
      version: z.string(),
      installedNow: z.boolean(),
      until: z.date().nullable(),
      run: releaseOutput.nullable(),
    })
    .nullable(),
  commands: commandsOutput,
  events: z.array(feedItem),
  cursor: feedCursorSchema,
  more: z.boolean(),
})

export const taskRouter = router({
  /**
   * A new dialog with the client's first words: the task, its reserve, the files, the row, the
   * pass and the preview in one transaction. `taskId` comes from the browser; a repeat returns the
   * same task. `requirements` — with the repository or in the browser (docs/plan/57, Б2, Б9);
   * absent, the server takes what the site offers (`project.get`, `capabilities`).
   */
  create: consentedProcedure
    .input(
      z.strictObject({
        siteId: z.uuid(),
        taskId: browserId,
        text: words,
        requirements: taskRequirementsSchema.optional(),
        attachments: attachmentIdsSchema.optional(),
        /** How hard the model thinks: `low`, `high` (the default) or `max`. */
        effort: reasoningEffortSchema.optional(),
      }),
    )
    .output(z.strictObject({ taskId: z.uuid(), alias: z.string(), created: z.boolean() }))
    .mutation(({ ctx, input }) =>
      createDialog(ctx.prisma, chatContextOf(ctx), {
        userId: ctx.user.id,
        siteId: input.siteId,
        taskId: input.taskId,
        text: input.text,
        ...(input.requirements === undefined ? {} : { requirements: input.requirements }),
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        now: new Date(),
      }),
    ),

  /** Words to a dialog that waits: an answer to the agent, or a new pass on top of the candidate. */
  message: consentedProcedure
    .input(
      z.strictObject({
        taskId: z.uuid(),
        requestId: browserId,
        text: words,
        attachments: attachmentIdsSchema.optional(),
      }),
    )
    .output(postedOutput)
    .mutation(({ ctx, input }) =>
      postDialogMessage(ctx.prisma, {
        userId: ctx.user.id,
        taskId: input.taskId,
        requestId: input.requestId,
        text: input.text,
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        now: new Date(),
      }),
    ),

  /**
   * «Продолжить работу агента» of a task in the browser that waits for the client (docs/plan/57,
   * Б16): the same attempt goes on, and its pass takes the browser back.
   */
  resumeAgent: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), requestId: browserId }))
    .output(postedOutput)
    .mutation(({ ctx, input }) =>
      resumeDialog(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** «Продолжить» after a question of the platform about credits: the next attempt. */
  continue: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), requestId: browserId }))
    .output(postedOutput)
    .mutation(({ ctx, input }) =>
      continueDialog(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /**
   * «Попробовать ещё» after a failed pass of a dialog that kept its candidate: the next attempt,
   * in the class `heavy`, with a reserve of its own (docs/plan/53, «Попробовать ещё (18.10)»).
   * `failureEventId` — the failure the screen shows.
   */
  retry: consentedProcedure
    .input(
      z.strictObject({ taskId: z.uuid(), requestId: browserId, failureEventId: feedEventIdSchema }),
    )
    .output(postedOutput)
    .mutation(({ ctx, input }) =>
      retryDialog(ctx.prisma, chatContextOf(ctx), {
        ...input,
        userId: ctx.user.id,
        now: new Date(),
      }),
    ),

  /**
   * `/cancel`: closes a dialog that waits, or asks core to stop the pass that runs — and, for a
   * task in the browser, to stop it in any status and close its browser (docs/plan/57, Б24).
   */
  cancel: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), requestId: browserId }))
    .output(postedOutput.extend({ state: z.enum(['cancelled', 'stopping']) }))
    .mutation(({ ctx, input }) =>
      cancelDialog(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** «Переименовать»: the name of the dialog in the list and its head (owner, 26.10.2026). */
  rename: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), title: z.string().max(1000) }))
    .output(z.strictObject({ title: z.string() }))
    .mutation(({ ctx, input }) => renameDialog(ctx.prisma, { ...input, userId: ctx.user.id })),

  /**
   * «Удалить»: the dialog leaves the cabinet; one that goes on is cancelled first, as `/cancel`
   * does it. Refused while a release of it goes on.
   */
  remove: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(z.strictObject({ removed: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      removeDialog(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** «Размышление» of a dialog that goes on: the level from its next turn (owner, 26.10.2026). */
  setEffort: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), effort: reasoningEffortSchema }))
    .output(z.strictObject({ effort: reasoningEffortSchema }))
    .mutation(({ ctx, input }) =>
      setDialogEffort(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** The head of the dialog and its rows after the cursor, from one snapshot. */
  feed: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), after: feedCursorSchema.optional() }))
    .output(feedOutput)
    .query(({ ctx, input }) =>
      readDialogFeed(ctx.prisma, {
        userId: ctx.user.id,
        taskId: input.taskId,
        after: input.after ?? '0',
        address: ctx.chat?.preview?.address ?? null,
      }),
    ),

  /**
   * The agent's work in one turn — its messages, commands, tool calls, changed files and
   * questions — after the cursor (owner's decision of 26.10.2026; services/chat/activity.ts).
   */
  activity: consentedProcedure
    .input(
      z.strictObject({
        taskId: z.uuid(),
        turn: z.number().int().min(1).max(999_999),
        after: feedCursorSchema.optional(),
      }),
    )
    .output(
      z.strictObject({
        events: z.array(activityEventSchema),
        cursor: feedCursorSchema,
        more: z.boolean(),
      }),
    )
    .query(({ ctx, input }) =>
      readTurnActivity(ctx.prisma, {
        userId: ctx.user.id,
        taskId: input.taskId,
        turn: input.turn,
        after: input.after ?? '0',
      }),
    ),

  /** The dialogs of a site, the latest changed first; `cursor` is `nextCursor` of the page before. */
  list: consentedProcedure
    .input(
      z.strictObject({
        siteId: z.uuid(),
        cursor: z.string().regex(DIALOG_CURSOR_PATTERN).optional(),
      }),
    )
    .output(
      z.strictObject({
        items: z.array(
          z.strictObject({
            id: z.uuid(),
            title: z.string().nullable(),
            status: z.enum(taskStatuses),
            mode: z.enum(taskModes),
            /** «Отменить выпуск» of the dialog's release: under way, or installed. */
            undo: z.enum(['running', 'installed']).nullable(),
            /** The agent answered and asked nothing: the dialog waits for no one (26.10.2026). */
            answered: z.boolean(),
            createdAt: z.date(),
            updatedAt: z.date(),
          }),
        ),
        nextCursor: z.string().nullable(),
      }),
    )
    .query(({ ctx, input }) => listDialogs(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** The head of one dialog with its site. */
  get: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(
      feedTaskHeadSchema.extend({
        siteId: z.uuid(),
        alias: z.string(),
        createdAt: z.date(),
        updatedAt: z.date(),
      }),
    )
    .query(({ ctx, input }) => readDialogHead(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** The commands of the chat with the server's verdict on each (Р34). */
  commands: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(commandsOutput)
    .query(async ({ ctx, input }) => {
      const task = await ctx.prisma.task.findFirst({
        where: accessibleTask(ctx.user.id, input.taskId),
        select: { id: true, workspaceId: true, siteId: true, status: true },
      })
      if (task === null) throw taskNotFound()
      return dialogCommands(await dialogFacts(ctx.prisma, task, ctx.user.id))
    }),
})
