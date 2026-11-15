import {
  TELEGRAM_DELIVER_JOB,
  TELEGRAM_FORGET_JOB,
  TELEGRAM_PROGRESS_JOB,
  TELEGRAM_QUEUE,
  TELEGRAM_SEND_JOB,
  TELEGRAM_TOPIC_JOB,
  telegramDeliverDedupeKey,
  telegramDeliverJobSchema,
  telegramProgressJobSchema,
  telegramSendJobSchema,
  telegramTopicDedupeKey,
  telegramTopicJobSchema,
  type TelegramDeliverJob,
  type TelegramSendJob,
  type TelegramTopicJob,
} from '@repo/domain'

import type { Prisma } from './generated/prisma/client.ts'
import { enqueueOutbox, type OutboxWriter } from './outbox.ts'

// The bot of the chat (docs/plan/80-telegram.md): what it says goes through the outbox to core,
// which alone speaks to Telegram. Written in the transaction of what is told.

const lower = (id: string) => id.toLowerCase()

/**
 * One message of the bot. `key` — what makes it once: the update it answers, or the event it
 * tells of (at most 200 characters).
 */
export function enqueueTelegramSend(
  tx: OutboxWriter,
  job: TelegramSendJob,
  key: string,
): Promise<boolean> {
  const parsed = telegramSendJobSchema.parse(job)
  const payload: TelegramSendJob =
    parsed.taskId === undefined ? parsed : { ...parsed, taskId: lower(parsed.taskId) }
  return enqueueOutbox(tx, {
    topic: TELEGRAM_QUEUE,
    type: TELEGRAM_SEND_JOB,
    payload,
    dedupeKey: `${TELEGRAM_SEND_JOB}:${key.slice(0, 200)}`,
  })
}

/** A chat started in Telegram: core opens its topic, when the bot has topics. */
export function enqueueTelegramTopic(tx: OutboxWriter, job: TelegramTopicJob): Promise<boolean> {
  const parsed = telegramTopicJobSchema.parse(job)
  const payload: TelegramTopicJob = { taskId: lower(parsed.taskId) }
  return enqueueOutbox(tx, {
    topic: TELEGRAM_QUEUE,
    type: TELEGRAM_TOPIC_JOB,
    payload,
    dedupeKey: telegramTopicDedupeKey(payload),
  })
}

/**
 * A pass ended: core sends its rows to Telegram — only for a chat bound there (a chat session of
 * the channel `telegram`). Returns false when the chat is not bound or the job is written already.
 */
export async function enqueueTelegramDeliver(
  tx: OutboxWriter & Pick<Prisma.TransactionClient, 'task'>,
  job: TelegramDeliverJob,
): Promise<boolean> {
  const parsed = telegramDeliverJobSchema.parse(job)
  const task = await tx.task.findUnique({
    where: { id: parsed.taskId },
    select: { chatSession: { select: { channel: true } } },
  })
  if (task?.chatSession?.channel !== 'telegram') return false
  const payload: TelegramDeliverJob = { ...parsed, taskId: lower(parsed.taskId) }
  return enqueueOutbox(tx, {
    topic: TELEGRAM_QUEUE,
    type: TELEGRAM_DELIVER_JOB,
    payload,
    dedupeKey: telegramDeliverDedupeKey(payload),
  })
}

/**
 * The message of the work of the agent for a chat bound to Telegram: core sends it and edits it
 * every few seconds while the pass goes on. `key` — what makes it once (the update it answers).
 */
export function enqueueTelegramProgress(
  tx: OutboxWriter,
  taskId: string,
  key: string,
  pressId?: string,
): Promise<boolean> {
  const payload = telegramProgressJobSchema.parse({
    taskId: lower(taskId),
    ...(pressId === undefined ? {} : { pressId }),
  })
  return enqueueOutbox(tx, {
    topic: TELEGRAM_QUEUE,
    type: TELEGRAM_PROGRESS_JOB,
    payload,
    dedupeKey: `${TELEGRAM_PROGRESS_JOB}:${key.slice(0, 200)}`,
  })
}

/**
 * A chat deleted in the cabinet (owner's request of 15.11.2026): its topic in Telegram is deleted
 * with all its messages, and the chat stops being bound there. Written in the transaction of the
 * delete; a chat not bound to a topic has nothing to delete.
 */
export async function forgetTelegramChat(
  tx: OutboxWriter & Pick<Prisma.TransactionClient, 'task' | 'chatSession'>,
  taskId: string,
): Promise<boolean> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: {
      chatSession: {
        select: { id: true, channel: true, externalChatId: true, telegramTopicId: true },
      },
    },
  })
  const session = task?.chatSession
  if (session?.channel !== 'telegram' || session.externalChatId === null) return false
  await tx.chatSession.update({
    where: { id: session.id },
    data: {
      externalChatId: null,
      telegramTopicId: null,
      telegramProgressId: null,
      telegramProgressChain: null,
    },
  })
  if (session.telegramTopicId === null) return false
  return enqueueOutbox(tx, {
    topic: TELEGRAM_QUEUE,
    type: TELEGRAM_FORGET_JOB,
    payload: { chatId: session.externalChatId, threadId: session.telegramTopicId },
    dedupeKey: `${TELEGRAM_FORGET_JOB}:${session.externalChatId}:${session.telegramTopicId}`,
  })
}
