import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import {
  agentEventSchema,
  feedRowMarkdown,
  readFeedRow,
  type FeedItem,
  type TelegramButton,
  type AgentEvent,
  type TaskStatus,
  type TelegramDeliverJob,
  type TelegramForgetJob,
  type TelegramProgressJob,
  type TelegramSendJob,
  type TelegramTopicJob,
} from '@repo/domain'
import {
  escapeTelegramHtml,
  markdownToTelegramParts,
  type InlineKeyboardButton,
  type TelegramApiResult,
  type TelegramBotApi,
} from '@repo/telegram'
import { UnrecoverableError } from 'bullmq'
import { z } from 'zod'

import {
  TELEGRAM_PROGRESS_EVERY_MS,
  TELEGRAM_PROGRESS_MAX_TICKS,
  progressText,
} from './progress-text.ts'

// The bot of the chat in Telegram, the side of core (docs/plan/80-telegram.md, §7): Telegram does
// not reach the server, so core reads the updates of the bot and posts each to web, which answers
// in the chat services; and core alone sends what the bot says — the answers web wrote to the
// outbox, the rows of a pass that ended, the topic of a new chat. Logs carry ids and Telegram's own
// descriptions, never the words of a message.

/** The updates a poll asks for: words, files and presses of buttons. */
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query'] as const
/** Updates one poll takes at most. */
export const TELEGRAM_POLL_BATCH = 50
/**
 * An update web cannot read (400, 413) is given up after this many answers, so the next ones are
 * not held behind it. Any other failure — web away, a deploy, the database, a secret being rotated —
 * is tried again on every tick: Telegram keeps an update for a day, and a client's words are never
 * dropped for an outage.
 */
export const TELEGRAM_UPDATE_TRIES = 5
/** Web may take a voice of 11 pieces and a file of 20 MB: its slowest path, with room. */
export const TELEGRAM_INTAKE_TIMEOUT_MS = 5 * 60_000
/** How long `getMe` is trusted for whether the bot has topics in private chats. */
export const TELEGRAM_BOT_INFO_MS = 10 * 60_000
/** Kept rows of `telegram_updates`: the largest one always stays, as the next offset. */
export const TELEGRAM_UPDATES_KEPT_MS = 7 * 24 * 3_600_000

export interface TelegramLogger {
  log(line: string): void
  warn(line: string): void
}

export interface TelegramJobsDeps {
  prisma: Pick<
    PrismaClient,
    'telegramUpdate' | 'task' | 'taskTurn' | 'taskEvent' | 'chatSession' | 'channelIdentity'
  >
  bot: Pick<
    TelegramBotApi,
    | 'call'
    | 'getMe'
    | 'sendMessage'
    | 'answerCallbackQuery'
    | 'createForumTopic'
    | 'deleteForumTopic'
    | 'editMessageText'
    | 'deleteMessage'
    | 'sendChatAction'
  >
  /** Puts the next edit of the message of the work in the queue `telegram`, `delayMs` later. */
  later: (job: TelegramProgressJob, delayMs: number) => Promise<void>
  /** The route `/api/webhooks/telegram` of web, and the secret it checks. */
  intake: { url: string; secret: string }
  /** APP_URL: the bot links to the chats of the cabinet under it. */
  appUrl: string
  fetch?: typeof fetch
  logger: TelegramLogger
  now?: () => Date
}

/** A failure of Telegram: its description only, never the request. */
export class TelegramFailure extends Error {
  readonly retryAfterSec: number | undefined

  constructor(method: string, result: Extract<TelegramApiResult<unknown>, { ok: false }>) {
    super(`Telegram ${method} failed: ${result.errorCode ?? '?'} ${result.description}`)
    this.name = 'TelegramFailure'
    this.retryAfterSec = result.retryAfterSec
  }
}

const rawUpdates = z.array(z.looseObject({ update_id: z.number().int().nonnegative() }))

/** The rows of a pass Telegram is told of: what the agent says, never the client's own words. */
const TOLD: ReadonlySet<string> = new Set([
  'feed.result',
  'feed.question',
  'feed.failure',
  'feed.candidate',
  'feed.cancelled',
  'feed.file',
  'feed.file_left',
  'feed.page',
  'feed.page_left',
  'feed.doc_left',
])

export const telegramJobText = {
  open: 'Открыть в кабинете',
  release: 'Посмотреть и выпустить',
  continue: 'Продолжить',
  topic: (title: string) => `Чат «${title}». Отвечу здесь.`,
  untitled: 'Новый чат',
} as const

/** The statuses of a chat whose pass goes on: the message of the work stands. */
const WORKING: readonly TaskStatus[] = ['queued', 'preparing', 'running']

/** Telegram refused a message into a topic that is no more. */
const threadGone = (result: Extract<TelegramApiResult<unknown>, { ok: false }>) =>
  result.errorCode === 400 &&
  /thread not found|topic_deleted|TOPIC_ID_INVALID/i.test(result.description)

const keyboardOf = (buttons: readonly (readonly TelegramButton[])[]): InlineKeyboardButton[][] =>
  buttons.map((row) =>
    row.map((button) =>
      'url' in button
        ? { text: button.text, url: button.url }
        : { text: button.text, callback_data: button.data },
    ),
  )

export class TelegramJobs {
  readonly #deps: TelegramJobsDeps
  readonly #failures = new Map<number, number>()
  #topics: { on: boolean; at: number } | undefined

  constructor(deps: TelegramJobsDeps) {
    this.#deps = deps
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date()
  }

  #chatLink(taskId: string): string {
    return `${this.#deps.appUrl.replace(/\/+$/, '')}/chats/${taskId}`
  }

  /**
   * Reads the updates after the largest one web took and posts each to web, in order. A refusal
   * stops the poll there: the next tick tries the same update; after TELEGRAM_UPDATE_TRIES it is
   * given up and kept as taken, so the updates after it go on.
   */
  async poll(): Promise<number> {
    const { prisma, bot, logger } = this.#deps
    const last = await prisma.telegramUpdate.findFirst({
      orderBy: { updateId: 'desc' },
      select: { updateId: true },
    })
    const body: Record<string, unknown> = {
      timeout: 0,
      limit: TELEGRAM_POLL_BATCH,
      allowed_updates: TELEGRAM_ALLOWED_UPDATES,
    }
    if (last) body.offset = Number(last.updateId) + 1
    const got = await bot.call('getUpdates', body, rawUpdates)
    if (!got.ok) throw new TelegramFailure('getUpdates', got)
    let taken = 0
    for (const update of got.result) {
      if (last && update.update_id <= Number(last.updateId)) continue
      const answer = await this.#post(update)
      if (answer === 'taken') {
        this.#failures.delete(update.update_id)
        taken += 1
        continue
      }
      if (answer === 'later') break
      const tries = (this.#failures.get(update.update_id) ?? 0) + 1
      this.#failures.set(update.update_id, tries)
      if (tries < TELEGRAM_UPDATE_TRIES) break
      logger.warn(`Telegram update ${update.update_id} is given up: web cannot read it`)
      this.#failures.delete(update.update_id)
      await prisma.telegramUpdate.createMany({
        data: [{ updateId: BigInt(update.update_id) }],
        skipDuplicates: true,
      })
    }
    await this.#sweep()
    return taken
  }

  /** `taken`; `unreadable` — web will never take it; `later` — web is away, try again. */
  async #post(update: unknown): Promise<'taken' | 'unreadable' | 'later'> {
    const { intake, logger } = this.#deps
    try {
      const response = await (this.#deps.fetch ?? fetch)(intake.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': intake.secret,
        },
        body: JSON.stringify(update),
        signal: AbortSignal.timeout(TELEGRAM_INTAKE_TIMEOUT_MS),
      })
      await response.body?.cancel().catch(() => undefined)
      if (response.ok) return 'taken'
      logger.warn(`Web refused a Telegram update: HTTP ${response.status}`)
      return response.status === 400 || response.status === 413 ? 'unreadable' : 'later'
    } catch (error) {
      logger.warn(
        `Web did not take a Telegram update: ${error instanceof Error ? error.name : 'Error'}`,
      )
      return 'later'
    }
  }

  /**
   * Tells web the client deleted the topic of a chat (owner's request of 15.11.2026): Telegram says
   * nothing to a bot of it, a message into the topic is refused. Web deletes the chat as «Удалить»
   * of the cabinet does; a failure throws, so the job is tried again.
   */
  async #topicGone(chatId: string, threadId: number): Promise<void> {
    const { intake } = this.#deps
    const response = await (this.#deps.fetch ?? fetch)(intake.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': intake.secret,
      },
      body: JSON.stringify({ raditi_topic_gone: { chat_id: chatId, thread_id: threadId } }),
      signal: AbortSignal.timeout(TELEGRAM_INTAKE_TIMEOUT_MS),
    })
    await response.body?.cancel().catch(() => undefined)
    if (!response.ok) throw new Error(`Web refused a gone topic: HTTP ${response.status}`)
  }

  /** Forgets the updates of last week, the largest one aside: it is the next offset. */
  async #sweep(): Promise<void> {
    const { prisma } = this.#deps
    const last = await prisma.telegramUpdate.findFirst({
      orderBy: { updateId: 'desc' },
      select: { updateId: true },
    })
    if (!last) return
    await prisma.telegramUpdate.deleteMany({
      where: {
        receivedAt: { lt: new Date(this.#now().getTime() - TELEGRAM_UPDATES_KEPT_MS) },
        updateId: { lt: last.updateId },
      },
    })
  }

  /** The topic of a task's chat in Telegram, when it has one in this Telegram chat. */
  async #placeOf(taskId: string): Promise<{ chatId: string; threadId: number | undefined } | null> {
    const task = await this.#deps.prisma.task.findUnique({
      where: { id: taskId },
      select: {
        deletedAt: true,
        chatSession: { select: { channel: true, externalChatId: true, telegramTopicId: true } },
      },
    })
    const session = task?.chatSession
    if (!task || task.deletedAt !== null || session?.channel !== 'telegram') return null
    if (session.externalChatId === null) return null
    // A Telegram account unlinked since gets nothing of the chat (rule 1).
    const linked = await this.#deps.prisma.channelIdentity.findUnique({
      where: {
        channel_externalId: { channel: 'telegram', externalId: session.externalChatId },
      },
      select: { userId: true },
    })
    if (!linked) return null
    return { chatId: session.externalChatId, threadId: session.telegramTopicId ?? undefined }
  }

  async #send(
    chatId: string,
    threadId: number | undefined,
    html: string,
    buttons?: readonly (readonly TelegramButton[])[],
  ): Promise<number | 'gone'> {
    const { bot } = this.#deps
    const options = {
      parseMode: 'HTML' as const,
      ...(threadId === undefined ? {} : { threadId }),
      ...(buttons && buttons.length > 0 ? { inlineKeyboard: keyboardOf(buttons) } : {}),
    }
    const sent = await bot.sendMessage(chatId, html, options)
    if (sent.ok) return sent.result.message_id
    // The client deleted the topic in Telegram: the chat goes in the cabinet too.
    if (threadId !== undefined && threadGone(sent)) {
      await this.#topicGone(chatId, threadId)
      return 'gone'
    }
    // The client blocked the bot or deleted the chat: no try will get through.
    if (sent.errorCode === 403)
      throw new UnrecoverableError(new TelegramFailure('sendMessage', sent).message)
    throw new TelegramFailure('sendMessage', sent)
  }

  /** One message web wrote: an answer to a command, words or a press. */
  async send(job: TelegramSendJob): Promise<void> {
    if (job.pressId !== undefined) {
      // A press older than a few minutes cannot be answered any more: only its message matters.
      await this.#deps.bot.answerCallbackQuery(job.pressId).catch(() => undefined)
    }
    let threadId = job.threadId
    if (job.taskId !== undefined) {
      const place = await this.#placeOf(job.taskId)
      if (place?.chatId === job.chatId && place.threadId !== undefined) threadId = place.threadId
    }
    await this.#send(job.chatId, threadId, escapeTelegramHtml(job.text), job.buttons)
  }

  /** The rows of a pass that ended, in the words of the cabinet, to the chat bound in Telegram. */
  async deliver(job: TelegramDeliverJob): Promise<'sent' | 'skipped'> {
    const { prisma } = this.#deps
    const place = await this.#placeOf(job.taskId)
    if (place === null) return 'skipped'
    const [task, turn] = await Promise.all([
      prisma.task.findUniqueOrThrow({ where: { id: job.taskId }, select: { siteId: true } }),
      prisma.taskTurn.findUnique({
        where: { taskId_turnNo: { taskId: job.taskId, turnNo: job.turnNo } },
        select: { id: true },
      }),
    ])
    const events = await prisma.taskEvent.findMany({
      where: {
        taskId: job.taskId,
        clientVisible: true,
        ...(turn ? { turnId: turn.id } : {}),
        type: { in: [...TOLD] },
      },
      orderBy: { id: turn ? 'asc' : 'desc' },
      take: turn ? 40 : 1,
      select: { id: true, type: true, payload: true, createdAt: true },
    })
    if (!turn) events.reverse()
    const rows: FeedItem[] = events.map((event) => ({
      ...readFeedRow(event.type, event.payload),
      id: String(event.id),
      at: event.createdAt.toISOString(),
    }))
    const markdown = rows
      .map((row) => feedRowMarkdown(row, task.siteId !== null))
      .filter((block): block is string => block !== null)
      .join('\n\n')
    await this.#clearProgress(job.taskId)
    const parts = markdownToTelegramParts(markdown)
    if (parts.length === 0) return 'skipped'
    const buttons: TelegramButton[][] = []
    const ceiling = rows.some((row) => row.type === 'feed.question' && row.kind === 'ceiling')
    if (ceiling) buttons.push([{ text: telegramJobText.continue, data: `go:${job.taskId}` }])
    buttons.push([
      {
        text: job.kind === 'ready' ? telegramJobText.release : telegramJobText.open,
        url: this.#chatLink(job.taskId),
      },
    ])
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1
      if (
        (await this.#send(place.chatId, place.threadId, part, last ? buttons : undefined)) ===
        'gone'
      )
        return 'skipped'
    }
    return 'sent'
  }

  /**
   * A chat started in Telegram outside a topic gets its own topic, when the bot has topics in
   * private chats; the answers of the agent go there.
   */
  async topic(job: TelegramTopicJob): Promise<'opened' | 'skipped'> {
    const { prisma, bot, logger } = this.#deps
    const task = await prisma.task.findUnique({
      where: { id: job.taskId },
      select: {
        title: true,
        deletedAt: true,
        chatSession: {
          select: { id: true, channel: true, externalChatId: true, telegramTopicId: true },
        },
      },
    })
    const session = task?.chatSession
    if (!task || task.deletedAt !== null || session?.channel !== 'telegram') return 'skipped'
    if (session.telegramTopicId !== null || session.externalChatId === null) return 'skipped'
    if (!(await this.#topicsOn())) return 'skipped'
    const title = task.title?.trim() || telegramJobText.untitled
    const made = await bot.createForumTopic(session.externalChatId, title)
    if (!made.ok) {
      // A client of Telegram that has no topics: the chat goes on without one.
      if (made.errorCode === 400) {
        logger.warn(`Telegram createForumTopic refused: ${made.description}`)
        return 'skipped'
      }
      throw new TelegramFailure('createForumTopic', made)
    }
    const threadId = made.result.message_thread_id
    const { count } = await prisma.chatSession.updateMany({
      where: { id: session.id, telegramTopicId: null },
      data: { telegramTopicId: threadId },
    })
    if (count === 0) return 'skipped'
    await this.#send(
      session.externalChatId,
      threadId,
      escapeTelegramHtml(telegramJobText.topic(title)),
      [[{ text: telegramJobText.open, url: this.#chatLink(job.taskId) }]],
    )
    return 'opened'
  }

  /**
   * The message of the work of the agent (owner's request of 15.11.2026): sent once, then edited
   * every TELEGRAM_PROGRESS_EVERY_MS while the pass goes on, with «печатает…» above the field; the
   * answer of the pass deletes it. A newer run of it takes the message over, an older one stops.
   */
  async progress(job: TelegramProgressJob): Promise<'ticked' | 'stopped' | 'skipped'> {
    const { prisma, bot } = this.#deps
    if (job.pressId !== undefined) await bot.answerCallbackQuery(job.pressId).catch(() => undefined)
    const place = await this.#placeOf(job.taskId)
    if (place === null) return 'skipped'
    const task = await prisma.task.findUniqueOrThrow({
      where: { id: job.taskId },
      select: {
        status: true,
        chatSession: {
          select: { id: true, telegramProgressId: true, telegramProgressChain: true },
        },
      },
    })
    const session = task.chatSession!
    if (job.chain !== undefined && session.telegramProgressChain !== job.chain) return 'skipped'
    if (!WORKING.includes(task.status)) {
      // The pass ended: its answer deletes the message; a stop or a failure without one, here.
      if (job.chain !== undefined) await this.#clearProgress(job.taskId)
      return 'stopped'
    }
    const chain = job.chain ?? randomUUID()
    if (job.chain === undefined)
      await prisma.chatSession.update({
        where: { id: session.id },
        data: { telegramProgressChain: chain },
      })
    const tick = job.tick ?? 0
    const text = escapeTelegramHtml(
      progressText({
        tick,
        status: task.status,
        event: await this.#lastEvent(job.taskId),
        elapsedMs: this.#now().getTime() - (await this.#since(job.taskId)).getTime(),
      }),
    )
    const buttons: TelegramButton[][] = [
      [
        { text: 'Остановить', data: `stop:${job.taskId}` },
        { text: telegramJobText.open, url: this.#chatLink(job.taskId) },
      ],
    ]
    let messageId = session.telegramProgressId
    if (messageId !== null) {
      const edited = await bot.editMessageText(place.chatId, messageId, text, {
        inlineKeyboard: keyboardOf(buttons),
      })
      if (!edited.ok && !/not modified/i.test(edited.description)) {
        // The client deleted the message: a new one takes its place.
        if (/not found|can't be edited/i.test(edited.description)) messageId = null
        else throw new TelegramFailure('editMessageText', edited)
      }
    }
    if (messageId === null) {
      const sent = await this.#send(place.chatId, place.threadId, text, buttons)
      if (sent === 'gone') return 'stopped'
      const { count } = await prisma.chatSession.updateMany({
        where: { id: session.id, telegramProgressChain: chain },
        data: { telegramProgressId: sent },
      })
      // Taken over meanwhile: this message is not the one that stays.
      if (count === 0) await bot.deleteMessage(place.chatId, sent).catch(() => undefined)
    }
    await bot.sendChatAction(place.chatId, 'typing', place.threadId).catch(() => undefined)
    if (tick < TELEGRAM_PROGRESS_MAX_TICKS)
      await this.#deps.later(
        { taskId: job.taskId, chain, tick: tick + 1 },
        TELEGRAM_PROGRESS_EVERY_MS,
      )
    return 'ticked'
  }

  /** Deletes the message of the work of a task, if it has one, and stops its run. */
  async #clearProgress(taskId: string): Promise<void> {
    const { prisma, bot } = this.#deps
    const task = await prisma.task.findUnique({
      where: { id: taskId },
      select: {
        chatSession: {
          select: {
            id: true,
            externalChatId: true,
            telegramProgressId: true,
            telegramProgressChain: true,
          },
        },
      },
    })
    const session = task?.chatSession
    if (!session || (session.telegramProgressId === null && session.telegramProgressChain === null))
      return
    const { externalChatId, telegramProgressId } = session
    await prisma.chatSession.update({
      where: { id: session.id },
      data: { telegramProgressId: null, telegramProgressChain: null },
    })
    if (telegramProgressId !== null && externalChatId !== null)
      await bot.deleteMessage(externalChatId, telegramProgressId).catch(() => undefined)
  }

  /** The last event of the agent in the pass going on, from the journal of the turn. */
  async #lastEvent(taskId: string): Promise<AgentEvent | null> {
    const row = await this.#deps.prisma.taskEvent.findFirst({
      where: { taskId, type: 'turn.output' },
      orderBy: { id: 'desc' },
      select: { payload: true },
    })
    const events = (row?.payload as { events?: unknown } | null)?.events
    if (!Array.isArray(events)) return null
    for (let index = events.length - 1; index >= 0; index--) {
      const parsed = agentEventSchema.safeParse(events[index])
      if (parsed.success && !['started', 'usage', 'completed', 'failed'].includes(parsed.data.type))
        return parsed.data
    }
    return null
  }

  /** When the client's words of this pass came: the last request of the chat. */
  async #since(taskId: string): Promise<Date> {
    const row = await this.#deps.prisma.taskEvent.findFirst({
      where: { taskId, type: 'feed.request' },
      orderBy: { id: 'desc' },
      select: { createdAt: true },
    })
    return row?.createdAt ?? this.#now()
  }

  /** A chat deleted in the cabinet: its topic goes with all its messages. */
  async forget(job: TelegramForgetJob): Promise<'deleted' | 'skipped'> {
    const done = await this.#deps.bot.deleteForumTopic(job.chatId, job.threadId)
    if (done.ok) return 'deleted'
    // The topic is gone already, or the client blocked the bot: nothing is left to delete.
    if (done.errorCode === 400 || done.errorCode === 403) return 'skipped'
    throw new TelegramFailure('deleteForumTopic', done)
  }

  async #topicsOn(): Promise<boolean> {
    const now = this.#now().getTime()
    if (this.#topics && now - this.#topics.at < TELEGRAM_BOT_INFO_MS) return this.#topics.on
    const me = await this.#deps.bot.getMe()
    if (!me.ok) throw new TelegramFailure('getMe', me)
    this.#topics = { on: me.result.has_topics_enabled === true, at: now }
    return this.#topics.on
  }
}
