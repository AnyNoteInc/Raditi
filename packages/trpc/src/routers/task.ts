import {
  appEnvSchema,
  chatCommandRefusals,
  chatProjectSchema,
  FEED_REQUEST_TEXT_LIMIT,
  feedCursorSchema,
  feedReadCursorSchema,
  feedTaskHeadSchema,
  pullRequestStates,
  reasoningEffortSchema,
  repoBranchStates,
  scheduledRunTriggers,
  serverCommandIds,
  taskStatuses,
  type FeedItem,
} from '@repo/domain'
import { z } from 'zod'

import { activityEventSchema, readTurnActivity } from '../services/chat/activity.ts'
import { attachmentIdsSchema } from '../services/chat/attachments.ts'
import { feedBrowserOutput } from '../services/chat/browser.ts'
import { chatContextOf } from '../services/chat/context.ts'
import {
  DIALOG_CURSOR_PATTERN,
  DIALOG_SEARCH_TEXT,
  listDialogs,
  searchDialogs,
} from '../services/chat/dialog-list.ts'
import { readDialogExport, readDialogFeed, readDialogHead } from '../services/chat/feed.ts'
import { readTaskSignals } from '../services/chat/signals.ts'
import { markPresence } from '../services/notifications.ts'
import {
  editQueuedWords,
  listQueuedWords,
  queueDialogWords,
  removeQueuedWords,
  sendQueuedNow,
} from '../services/chat/queue.ts'
import {
  archiveDialog,
  moveDialogToProject,
  pinDialog,
  removeDialog,
  renameDialog,
  setDialogEffort,
} from '../services/chat/dialog-manage.ts'
import { dialogCommands, dialogFacts } from '../services/chat/dialog-facts.ts'
import { accessibleTask, taskNotFound } from '../services/chat/access.ts'
import { readChatInfo } from '../services/chat/info.ts'
import {
  cancelDialog,
  continueDialog,
  createDialog,
  agentCommandDialog,
  postDialogMessage,
  resumeDialog,
  redoDialogTurn,
  undoDialogTurn,
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
    id: z.enum(serverCommandIds),
    available: z.boolean(),
    refusal: z.enum(chatCommandRefusals).nullable(),
  }),
)

/** A row of the feed as `readFeedRow` gave it: its shape is the domain's, checked on reading. */
const feedItem = z.custom<FeedItem>(
  (value) =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { type?: unknown }).type === 'string',
)

const feedOutput = z.strictObject({
  task: feedTaskHeadSchema,
  /**
   * The cloud browser of a task in the browser (docs/plan/57-browser-tasks.md, Б12–Б18): its
   * latest session — who drives it, what the agent asked the client to do there, why it closed;
   * null for a chat without the browser, or before the first pass opened one.
   */
  browser: feedBrowserOutput,
  commands: commandsOutput,
  events: z.array(feedItem),
  /** The last row read and what the read could not see: rows that commit late come next. */
  cursor: feedReadCursorSchema,
  more: z.boolean(),
})

/**
 * «По расписанию · <name>» or «Запуск вручную · <name>» of a chat of a run (Зп43): `id` null — the
 * task was deleted, the label stays without a link (Зп23).
 */
const scheduleLabelOutput = z.strictObject({
  id: z.uuid().nullable(),
  name: z.string(),
  trigger: z.enum(scheduledRunTriggers),
})

/** A chat of the list, of its head of pinned chats and of a search. */
const dialogListItemOutput = z.strictObject({
  id: z.uuid(),
  title: z.string().nullable(),
  status: z.enum(taskStatuses),
  /** The agent answered and asked nothing: the dialog waits for no one (26.10.2026). */
  answered: z.boolean(),
  /** `/undo` left it so: the answer it would name was just taken back. */
  rewound: z.boolean(),
  /** The last pass failed: nothing to confirm, the list says «Ошибка» (06.11.2026). */
  failed: z.boolean(),
  createdAt: z.date(),
  updatedAt: z.date(),
  /** «Закрепить» (ВВ21). */
  pinned: z.boolean(),
  /** The project the chat is in (docs/plan/84-projects.md, ПР2); null — none. */
  project: chatProjectSchema.nullable(),
  /** «В архив» (ВВ21). */
  archived: z.boolean(),
  /** The chat goes on in Telegram too (docs/plan/80-telegram.md, 80.6). */
  telegram: z.boolean(),
  /** The chat is a run of a scheduled task (docs/plan/82-scheduled-tasks.md, Зп43). */
  schedule: scheduleLabelOutput.nullable(),
  /** The chat's branch in the repository of its project (docs/plan/84-projects.md, §4.8). */
  repo: z
    .strictObject({
      state: z.enum(repoBranchStates),
      sent: z.boolean(),
      request: z.strictObject({ state: z.enum(pullRequestStates) }).nullable(),
    })
    .nullable(),
})

const credits = z.number().int().nonnegative()
const chatInfoOutput = z.strictObject({
  usage: z.strictObject({
    plan: z.string().nullable(),
    total: credits,
    tariff: credits,
    gift: credits,
    pack: credits,
    week: z
      .strictObject({ limit: credits, used: credits, left: credits, resetsAt: z.date().nullable() })
      .nullable(),
    chat: credits.nullable(),
  }),
  status: z
    .strictObject({
      title: z.string().nullable(),
      status: z.string().min(1),
      model: z.string().nullable(),
      effort: reasoningEffortSchema,
      queued: credits,
      browser: z.boolean(),
    })
    .nullable(),
  context: z
    .strictObject({ used: credits.nullable(), window: z.number().int().positive().nullable() })
    .nullable(),
})

export const taskRouter = router({
  /**
   * A new chat with the client's first words: the task, its reserve, the files, the row and the
   * pass in one transaction. `taskId` comes from the browser; a repeat returns the same task. What
   * the chat works with is the server's (docs/plan/61-chats-first.md, К7).
   */
  create: consentedProcedure
    .input(
      z.strictObject({
        taskId: browserId,
        text: words,
        attachments: attachmentIdsSchema.optional(),
        /** How hard the model thinks: `low`, `high` (the default) or `max`. */
        effort: reasoningEffortSchema.optional(),
        /**
         * The project the chat starts in (docs/plan/84-projects.md, ПР30); null or absent — none.
         * Fixed with the first message: later only `moveToProject` changes it.
         */
        projectId: browserId.nullable().optional(),
      }),
    )
    .output(z.strictObject({ taskId: z.uuid(), created: z.boolean() }))
    .mutation(({ ctx, input }) =>
      createDialog(ctx.prisma, chatContextOf(ctx), {
        userId: ctx.user.id,
        taskId: input.taskId,
        text: input.text,
        ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        projectId: input.projectId ?? null,
        now: new Date(),
      }),
    ),

  /**
   * «Перенести в проект…» and «Убрать из проекта» (docs/plan/84-projects.md, ПР2): refused with
   * TASK_PROJECT_BUSY while a pass of the chat is queued or runs.
   */
  moveToProject: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), projectId: browserId.nullable() }))
    .output(z.strictObject({ projectId: z.uuid().nullable() }))
    .mutation(({ ctx, input }) =>
      moveDialogToProject(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** Words to a chat that waits: an answer to the agent, or a new pass. */
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

  /**
   * `/compact`: the session of the chat is replaced by a summary, a paid pass of its own, free when
   * it fails (docs/plan/61-chats-first.md, К30).
   */
  compact: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), requestId: browserId }))
    .output(postedOutput)
    .mutation(({ ctx, input }) =>
      agentCommandDialog(ctx.prisma, {
        ...input,
        command: 'compact',
        userId: ctx.user.id,
        now: new Date(),
      }),
    ),

  /**
   * `/undo`: the last turn of a chat without the repository is taken back, free and without the
   * model (docs/plan/61-chats-first.md, К29); `words` — what the client wrote for it, for the field.
   */
  undoTurn: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), requestId: browserId }))
    .output(postedOutput.extend({ words: z.string().nullable() }))
    .mutation(({ ctx, input }) => undoDialogTurn(ctx.prisma, { ...input, userId: ctx.user.id })),

  /**
   * `/redo`: the turn `/undo` took comes back, free and without the model (§5.14); `words` — what
   * the client wrote for it, for the page to take out of the field.
   */
  redoTurn: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), requestId: browserId }))
    .output(postedOutput.extend({ words: z.string().nullable() }))
    .mutation(({ ctx, input }) => redoDialogTurn(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** «Продолжить» after a question of the platform about credits: the next attempt. */
  continue: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), requestId: browserId }))
    .output(postedOutput)
    .mutation(({ ctx, input }) =>
      continueDialog(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
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
   * «Удалить»: the chat leaves the cabinet; one that goes on is cancelled first, as `/cancel`
   * does it.
   */
  remove: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(z.strictObject({ removed: z.literal(true) }))
    .mutation(({ ctx, input }) =>
      removeDialog(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /**
   * Words written while the agent works (docs/plan/75-chat-input-output.md, ВВ1): they wait in
   * the queue of the chat and go when the pass ends. A dialog that waits answers TASK_NOT_BUSY:
   * the words go by `task.message`.
   */
  queueAdd: consentedProcedure
    .input(
      z.strictObject({
        taskId: z.uuid(),
        requestId: z.uuid(),
        text: z.string().max(20_000),
        attachments: z.array(z.uuid()).max(10).optional(),
      }),
    )
    .output(z.strictObject({ id: z.uuid().nullable(), repeated: z.boolean() }))
    .mutation(({ ctx, input }) => queueDialogWords(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** The words of the queue, oldest first (ВВ1). */
  queueList: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(
      z.strictObject({
        items: z.array(
          z.strictObject({
            id: z.uuid(),
            requestId: z.uuid(),
            text: z.string(),
            attachments: z.array(z.uuid()),
            createdAt: z.date(),
          }),
        ),
      }),
    )
    .query(async ({ ctx, input }) => ({
      items: await listQueuedWords(ctx.prisma, { ...input, userId: ctx.user.id }),
    })),

  /** «Изменить» of queued words, until the agent took them. */
  queueEdit: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), id: z.uuid(), text: z.string().max(20_000) }))
    .output(z.strictObject({ text: z.string() }))
    .mutation(({ ctx, input }) => editQueuedWords(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** «Убрать» of queued words. */
  queueRemove: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), id: z.uuid() }))
    .output(z.strictObject({ removed: z.literal(true) }))
    .mutation(({ ctx, input }) => removeQueuedWords(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** «Отправить сейчас» (ВВ4): the pass stops, and the queue goes next. */
  queueSendNow: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), requestId: z.uuid() }))
    .output(z.strictObject({ requestEventId: z.string().nullable() }))
    .mutation(({ ctx, input }) => sendQueuedNow(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** «Закрепить» / «Открепить» (docs/plan/75-chat-input-output.md, ВВ21). */
  pin: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), pinned: z.boolean() }))
    .output(z.strictObject({ pinned: z.boolean() }))
    .mutation(({ ctx, input }) =>
      pinDialog(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
    ),

  /** «В архив» / «Из архива» (ВВ21): a new message brings the chat back as well. */
  archive: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid(), archived: z.boolean() }))
    .output(z.strictObject({ archived: z.boolean() }))
    .mutation(({ ctx, input }) =>
      archiveDialog(ctx.prisma, { ...input, userId: ctx.user.id, now: new Date() }),
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
    .input(z.strictObject({ taskId: z.uuid(), after: feedReadCursorSchema.optional() }))
    .output(feedOutput)
    .query(async ({ ctx, input }) => {
      const feed = await readDialogFeed(ctx.prisma, {
        userId: ctx.user.id,
        taskId: input.taskId,
        after: input.after ?? '0',
      })
      // The client looks at the chat: it is not notified of it (docs/plan/75, ВВ7).
      await markPresence(ctx.prisma, ctx.user.id, feed.task.id)
      return feed
    }),

  /**
   * The signals of the chat (spec §7): `feed` — read `task.feed` now, `activity` — the agent's
   * output of the turn, `resync` — signals may have been missed, read both. Over SSE
   * (`httpSubscriptionLink`); the polls of the page go on, slower, as the fallback.
   */
  signals: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .subscription(async function* ({ ctx, input, signal }) {
      const signals = ctx.chat?.signals ?? null
      if (signals === null) return
      yield* readTaskSignals(ctx.prisma, signals, {
        userId: ctx.user.id,
        taskId: input.taskId,
        ...(signal ? { signal } : {}),
      })
    }),

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

  /**
   * The chats of the user, the latest changed first; `cursor` is `nextCursor` of the page before.
   */
  list: consentedProcedure
    .input(
      z.strictObject({
        cursor: z.string().regex(DIALOG_CURSOR_PATTERN).optional(),
        /** «Архив» (docs/plan/75-chat-input-output.md, ВВ21); the list itself by default. */
        view: z.enum(['active', 'archive']).optional(),
        /** The chats of one project of the user (docs/plan/84-projects.md, ПР2). */
        projectId: z
          .uuid()
          .transform((id) => id.toLowerCase())
          .optional(),
      }),
    )
    .output(
      z.strictObject({
        /** The pinned chats: on the first page of the list alone. */
        pinned: z.array(dialogListItemOutput),
        items: z.array(dialogListItemOutput),
        nextCursor: z.string().nullable(),
      }),
    )
    .query(({ ctx, input }) =>
      listDialogs(ctx.prisma, {
        userId: ctx.user.id,
        cursor: input.cursor,
        view: input.view,
        projectId: input.projectId,
      }),
    ),

  /** «Поиск по чатам» (ВВ21): by the name and by the client's words, in «Архив» too. */
  search: consentedProcedure
    .input(
      z.strictObject({
        query: z.string().min(1).max(DIALOG_SEARCH_TEXT),
        /** The window «Архив» searches its own chats only. */
        archive: z.boolean().optional(),
      }),
    )
    .output(z.strictObject({ items: z.array(dialogListItemOutput) }))
    .query(async ({ ctx, input }) => ({
      items: await searchDialogs(ctx.prisma, {
        userId: ctx.user.id,
        query: input.query,
        archiveOnly: input.archive === true,
      }),
    })),

  /** The head of one chat. */
  get: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(
      feedTaskHeadSchema.extend({
        createdAt: z.date(),
        updatedAt: z.date(),
        schedule: scheduleLabelOutput.nullable(),
      }),
    )
    .query(({ ctx, input }) => readDialogHead(ctx.prisma, { ...input, userId: ctx.user.id })),

  /** `/export`: the whole chat as a Markdown file, in the words of the screen (§5.14). */
  export: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(z.strictObject({ fileName: z.string(), markdown: z.string() }))
    .query(({ ctx, input }) => readDialogExport(ctx.prisma, { ...input, userId: ctx.user.id })),

  /**
   * `/usage`, `/status` and `/context` (owner's request of 15.11.2026): the credits, where the chat
   * stands and how full the context of the agent is; taskId absent — a new chat, credits only.
   */
  info: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid().optional() }))
    .output(chatInfoOutput)
    .query(({ ctx, input }) =>
      readChatInfo(ctx.prisma, {
        userId: ctx.user.id,
        taskId: input.taskId ?? null,
        appEnv: ctx.chat?.appEnv ?? ctx.billing?.appEnv ?? appEnvSchema.parse(process.env.APP_ENV),
        now: new Date(),
      }),
    ),

  /** The commands of the chat with the server's verdict on each (Р34). */
  commands: consentedProcedure
    .input(z.strictObject({ taskId: z.uuid() }))
    .output(commandsOutput)
    .query(async ({ ctx, input }) => {
      const task = await ctx.prisma.task.findFirst({
        where: accessibleTask(ctx.user.id, input.taskId),
        select: { id: true, workspaceId: true, status: true },
      })
      if (task === null) throw taskNotFound()
      return dialogCommands(await dialogFacts(ctx.prisma, task, ctx.user.id))
    }),
})
