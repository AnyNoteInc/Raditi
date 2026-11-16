import { z } from 'zod'

import { chatNotifyKinds } from '../tasks/agent-turn-job.ts'

/**
 * Telegram, the second channel of the chat (docs/plan/80-telegram.md). Telegram does not reach the
 * server, so core reads the bot's updates (`telegram.poll`) and hands each to web, which answers in
 * the chat services and writes what the bot says to the outbox; core sends it (`telegram.send`),
 * the endings of passes (`telegram.deliver`) and opens the topic of a chat (`telegram.topic`).
 * Job data carries ids, and the words of a message only for `telegram.send`.
 */
export const TELEGRAM_QUEUE = 'telegram'
/** The poll of the updates has a queue of its own: a slow update never holds up the replies. */
export const TELEGRAM_POLL_QUEUE = 'telegram-updates'
export const TELEGRAM_POLL_JOB = 'telegram.poll'
export const TELEGRAM_SEND_JOB = 'telegram.send'
export const TELEGRAM_DELIVER_JOB = 'telegram.deliver'
export const TELEGRAM_TOPIC_JOB = 'telegram.topic'
/** The message of the work of the agent, edited every few seconds while a pass goes on. */
export const TELEGRAM_PROGRESS_JOB = 'telegram.progress'
/** A chat deleted in the cabinet: its topic in Telegram goes with it. */
export const TELEGRAM_FORGET_JOB = 'telegram.forget'

/** A chat id of Telegram as a string: a private chat is the positive id of its user. */
export const telegramChatIdSchema = z.string().regex(/^-?\d{1,20}$/)

/** callback_data of a button of the bot: Telegram allows at most 64 bytes. */
export const telegramButtonDataSchema = z
  .string()
  .min(1)
  .refine((data) => new TextEncoder().encode(data).length <= 64, 'at most 64 bytes')

export const telegramButtonSchema = z.union([
  z.strictObject({ text: z.string().min(1).max(64), data: telegramButtonDataSchema }),
  z.strictObject({ text: z.string().min(1).max(64), url: z.url({ protocol: /^https?$/ }) }),
])
export type TelegramButton = z.infer<typeof telegramButtonSchema>

export const telegramSendJobSchema = z.strictObject({
  chatId: telegramChatIdSchema,
  /** The topic of a private chat with topics (Bot API 9.3); absent — the chat itself. */
  threadId: z.number().int().positive().optional(),
  /**
   * The topic of this task: core sends to it once it is open (`telegram.topic`). Wins over
   * `threadId` when the task has a topic.
   */
  taskId: z.uuid().optional(),
  /** Plain text: core escapes it. Up to 4096 characters, as Telegram takes. */
  text: z.string().min(1).max(4096),
  buttons: z.array(z.array(telegramButtonSchema).min(1).max(4)).max(10).optional(),
  /** The press this message answers: core stops the spinner of its button first. */
  pressId: z.string().min(1).max(64).optional(),
})
export type TelegramSendJob = z.infer<typeof telegramSendJobSchema>

/**
 * The rows of the feed told on their own (`eventId`), never with the rows of their pass: core
 * writes them after the pass was settled and its rows were sent — the cards of the changes of the
 * scheduled tasks a turn asked for (docs/plan/82-scheduled-tasks.md, Зп33, Зп35).
 */
export const telegramRowsToldAlone = ['feed.schedule_change', 'feed.schedule_left'] as const

/**
 * A pass of a chat bound to Telegram ended: core sends its rows there. `eventId` — one row of the
 * pass written after it ended (`telegramRowsToldAlone`): only it is sent, once.
 */
export const telegramDeliverJobSchema = z.strictObject({
  taskId: z.uuid(),
  kind: z.enum(chatNotifyKinds),
  attempt: z.number().int().min(1),
  turnNo: z.number().int().min(0),
  eventId: z
    .string()
    .regex(/^[1-9]\d{0,18}$/)
    .optional(),
})
export type TelegramDeliverJob = z.infer<typeof telegramDeliverJobSchema>

export const telegramDeliverDedupeKey = (job: TelegramDeliverJob): string =>
  job.eventId === undefined
    ? `${TELEGRAM_DELIVER_JOB}:${job.taskId}:${job.attempt}:${job.turnNo}:${job.kind}`
    : `${TELEGRAM_DELIVER_JOB}:${job.taskId}:event:${job.eventId}`

/** A chat started in Telegram gets its own topic when the bot has topics in private chats. */
export const telegramTopicJobSchema = z.strictObject({ taskId: z.uuid() })
export type TelegramTopicJob = z.infer<typeof telegramTopicJobSchema>

export const telegramTopicDedupeKey = (job: TelegramTopicJob): string =>
  `${TELEGRAM_TOPIC_JOB}:${job.taskId}`

export const telegramProgressJobSchema = z.strictObject({
  taskId: z.uuid(),
  /** Absent — a new run of the message; a tick carries the run it belongs to. */
  chain: z.uuid().optional(),
  tick: z.number().int().min(0).max(100_000).optional(),
  /** The press of «Продолжить» it answers: core stops the spinner of the button first. */
  pressId: z.string().min(1).max(64).optional(),
})
export type TelegramProgressJob = z.infer<typeof telegramProgressJobSchema>

export const telegramForgetJobSchema = z.strictObject({
  chatId: telegramChatIdSchema,
  threadId: z.number().int().positive(),
})
export type TelegramForgetJob = z.infer<typeof telegramForgetJobSchema>
