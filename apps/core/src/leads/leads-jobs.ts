import type { PrismaClient } from '@repo/db'
import type { TelegramApiResult, TelegramBotApi, TelegramCallbackQuery } from '@repo/telegram'

import { leadDoneData, leadDoneMessage, leadMessage, leadOfDoneData } from './lead-message.ts'

export const LEADS_QUEUE = 'leads'
export const LEAD_SEND_JOB = 'lead.send'
export const LEAD_POLL_JOB = 'lead.poll'
/** A lead not posted this long after it came — its sending ran out of tries — is posted again. */
export const LEAD_RESEND_AFTER_MS = 10 * 60_000
/** At most this many such leads per poll. */
const RESEND_BATCH = 5

export interface LeadsLogger {
  log(line: string): void
  warn(line: string): void
}

export interface LeadsJobsDeps {
  prisma: Pick<PrismaClient, 'lead'>
  bot: Pick<
    TelegramBotApi,
    'sendMessage' | 'getUpdates' | 'deleteMessage' | 'editMessageText' | 'answerCallbackQuery'
  >
  /** LEADS_TELEGRAM_CHAT_ID: the only group a lead goes to and a press is taken from. */
  chatId: string
  logger: LeadsLogger
  now?: () => Date
}

/** A failure of Telegram: the description of Telegram only, never the request. */
export class LeadTelegramError extends Error {
  constructor(method: string, result: Extract<TelegramApiResult<unknown>, { ok: false }>) {
    super(`Telegram ${method} failed: ${result.errorCode ?? '?'} ${result.description}`)
    this.name = 'LeadTelegramError'
  }
}

/**
 * The work of the queue of leads (docs/plan/65-landing-platforms-leads.md, Л9–Л11): posting a lead
 * to the group, and reading the presses of «Обработано», which mark the lead and delete its
 * message from Telegram. Logs carry the number of a lead, never what it says.
 */
export class LeadsJobs {
  readonly #deps: LeadsJobsDeps
  /** The next update to read; the presses before it are confirmed to Telegram by asking for it. */
  #offset: number | undefined

  constructor(deps: LeadsJobsDeps) {
    this.#deps = deps
  }

  /** Posts the lead unless it is posted already. A failure throws: BullMQ tries again. */
  async send(leadId: string): Promise<void> {
    const { prisma, bot, chatId, logger } = this.#deps
    const lead = await prisma.lead.findUnique({ where: { id: leadId } })
    if (!lead) {
      logger.warn(`Lead ${leadId} is gone before it was sent`)
      return
    }
    if (lead.telegramMessageId !== null || lead.processedAt !== null) return
    const sent = await bot.sendMessage(chatId, leadMessage(lead), {
      parseMode: 'HTML',
      inlineKeyboard: [[{ text: 'Обработано', callback_data: leadDoneData(lead.id) }]],
    })
    if (!sent.ok) throw new LeadTelegramError('sendMessage', sent)
    // A crash before this line posts the lead again on the next try (Л11): two messages rather
    // than none, each removed by its own button.
    await prisma.lead.updateMany({
      where: { id: lead.id, telegramMessageId: null },
      data: { telegramMessageId: BigInt(sent.result.message_id), sentAt: this.#now() },
    })
    logger.log(`Lead №${lead.number} is posted to Telegram`)
  }

  /**
   * Posts the leads whose sending gave up (Telegram or the proxy was away for hours), then reads
   * the presses since the last poll and handles each. Resolves to how many presses it read.
   */
  async poll(): Promise<number> {
    await this.#resend()
    const { bot } = this.#deps
    const updates = await bot.getUpdates({
      ...(this.#offset === undefined ? {} : { offset: this.#offset }),
      allowedUpdates: ['callback_query'],
      limit: 100,
    })
    if (!updates.ok) throw new LeadTelegramError('getUpdates', updates)
    for (const update of updates.result) {
      // A press whose handling threw (the database is away) stops the poll before the offset
      // moves past it: the next poll reads it again. Handling twice changes nothing, and
      // Telegram keeps an update for 24 hours.
      if (update.callback_query) await this.#pressed(update.callback_query)
      this.#offset = update.update_id + 1
    }
    return updates.result.length
  }

  async #resend(): Promise<void> {
    const { prisma, logger } = this.#deps
    const stale = await prisma.lead.findMany({
      where: {
        telegramMessageId: null,
        processedAt: null,
        createdAt: { lt: new Date(this.#now().getTime() - LEAD_RESEND_AFTER_MS) },
      },
      select: { id: true, number: true },
      orderBy: { createdAt: 'asc' },
      take: RESEND_BATCH,
    })
    for (const lead of stale) {
      try {
        await this.send(lead.id)
      } catch (error) {
        // Telegram is still away: the next poll tries again; the presses are read meanwhile.
        logger.warn(
          `Lead №${lead.number} is still not posted: ${error instanceof Error ? error.message : 'error'}`,
        )
        return
      }
    }
  }

  async #pressed(query: TelegramCallbackQuery): Promise<void> {
    const { prisma, bot, chatId, logger } = this.#deps
    const leadId = leadOfDoneData(query.data)
    const message = query.message
    // Only the group of leads: a forwarded message or another chat marks nothing.
    if (leadId === null || !message || String(message.chat.id) !== chatId) {
      await bot.answerCallbackQuery(query.id)
      return
    }
    const lead = await prisma.lead.findUnique({
      where: { id: leadId },
      select: { id: true, number: true, sentAt: true, processedAt: true },
    })
    if (lead && lead.processedAt === null) {
      const now = this.#now()
      await prisma.lead.updateMany({
        where: { id: lead.id, processedAt: null },
        data: { processedAt: now, sentAt: lead.sentAt ?? now },
      })
      logger.log(`Lead №${lead.number} is processed`)
    }
    // The data leaves Telegram: the message is deleted, or emptied when Telegram no longer lets
    // a bot delete it (48 hours after sending).
    const deleted = await bot.deleteMessage(chatId, message.message_id)
    if (!deleted.ok) {
      const emptied = await bot.editMessageText(
        chatId,
        message.message_id,
        lead ? leadDoneMessage(lead.number) : 'Заявка обработана.',
      )
      if (!emptied.ok) {
        logger.warn(
          `Lead message ${message.message_id} is neither deleted nor emptied: ` +
            `${deleted.description}; ${emptied.description}`,
        )
      }
    }
    await bot.answerCallbackQuery(query.id, 'Заявка обработана')
  }

  #now(): Date {
    return this.#deps.now?.() ?? new Date()
  }
}
