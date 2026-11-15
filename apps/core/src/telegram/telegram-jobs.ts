import type { PrismaClient } from '@repo/db'
import {
  feedRowMarkdown,
  readFeedRow,
  type FeedItem,
  type TelegramButton,
  type TelegramDeliverJob,
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

// The bot of the chat in Telegram, the side of core (docs/plan/80-telegram.md, §7): Telegram does
// not reach the server, so core reads the updates of the bot and posts each to web, which answers
// in the chat services; and core alone sends what the bot says — the answers web wrote to the
// outbox, the rows of a pass that ended, the topic of a new chat. Logs carry ids and Telegram's own
// descriptions, never the words of a message.

/** The updates a poll asks for: words, files and presses of buttons. */
export const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query'] as const
/** Updates one poll takes at most. */
export const TELEGRAM_POLL_BATCH = 50
/** An update web refused this many times is given up, so the next ones are not held behind it. */
export const TELEGRAM_UPDATE_TRIES = 5
/** How long `getMe` is trusted for whether the bot has topics in private chats. */
export const TELEGRAM_BOT_INFO_MS = 10 * 60_000
/** Kept rows of `telegram_updates`: the largest one always stays, as the next offset. */
export const TELEGRAM_UPDATES_KEPT_MS = 7 * 24 * 3_600_000

export interface TelegramLogger {
  log(line: string): void
  warn(line: string): void
}

export interface TelegramJobsDeps {
  prisma: Pick<PrismaClient, 'telegramUpdate' | 'task' | 'taskTurn' | 'taskEvent' | 'chatSession'>
  bot: Pick<
    TelegramBotApi,
    'call' | 'getMe' | 'sendMessage' | 'answerCallbackQuery' | 'createForumTopic'
  >
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
      if (await this.#post(update)) {
        this.#failures.delete(update.update_id)
        taken += 1
        continue
      }
      const tries = (this.#failures.get(update.update_id) ?? 0) + 1
      this.#failures.set(update.update_id, tries)
      if (tries < TELEGRAM_UPDATE_TRIES) break
      logger.warn(`Telegram update ${update.update_id} is given up after ${tries} refusals of web`)
      this.#failures.delete(update.update_id)
      await prisma.telegramUpdate.createMany({
        data: [{ updateId: BigInt(update.update_id) }],
        skipDuplicates: true,
      })
    }
    await this.#sweep()
    return taken
  }

  async #post(update: unknown): Promise<boolean> {
    const { intake, logger } = this.#deps
    try {
      const response = await (this.#deps.fetch ?? fetch)(intake.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': intake.secret,
        },
        body: JSON.stringify(update),
        signal: AbortSignal.timeout(60_000),
      })
      await response.body?.cancel().catch(() => undefined)
      if (response.ok) return true
      logger.warn(`Web refused a Telegram update: HTTP ${response.status}`)
      return false
    } catch (error) {
      logger.warn(
        `Web did not take a Telegram update: ${error instanceof Error ? error.name : 'Error'}`,
      )
      return false
    }
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
    return { chatId: session.externalChatId, threadId: session.telegramTopicId ?? undefined }
  }

  async #send(
    chatId: string,
    threadId: number | undefined,
    html: string,
    buttons?: readonly (readonly TelegramButton[])[],
  ): Promise<void> {
    const { bot } = this.#deps
    const options = {
      parseMode: 'HTML' as const,
      ...(threadId === undefined ? {} : { threadId }),
      ...(buttons && buttons.length > 0 ? { inlineKeyboard: keyboardOf(buttons) } : {}),
    }
    let sent = await bot.sendMessage(chatId, html, options)
    // The topic was deleted in Telegram: the chat itself takes the message.
    if (!sent.ok && threadId !== undefined && /thread not found/i.test(sent.description)) {
      const { threadId: _, ...withoutTopic } = options
      sent = await bot.sendMessage(chatId, html, withoutTopic)
    }
    if (sent.ok) return
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
      await this.#send(place.chatId, place.threadId, part, last ? buttons : undefined)
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

  async #topicsOn(): Promise<boolean> {
    const now = this.#now().getTime()
    if (this.#topics && now - this.#topics.at < TELEGRAM_BOT_INFO_MS) return this.#topics.on
    const me = await this.#deps.bot.getMe()
    if (!me.ok) throw new TelegramFailure('getMe', me)
    this.#topics = { on: me.result.has_topics_enabled === true, at: now }
    return this.#topics.on
  }
}
