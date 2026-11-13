import type { TelegramApiResult, TelegramUpdate } from '@repo/telegram'
import { describe, expect, it, vi } from 'vitest'

import { leadDoneData, leadMessage, leadOfDoneData, type LeadForMessage } from './lead-message.ts'
import { LeadsJobs, type LeadsJobsDeps } from './leads-jobs.ts'

const CHAT = '-1001234567890'
const NOW = new Date('2026-11-08T10:00:00Z')
const ID = '01900000-0000-7000-8000-000000000001'

type Row = LeadForMessage & {
  telegramMessageId: bigint | null
  sentAt: Date | null
  processedAt: Date | null
}

const lead = (over: Partial<Row> = {}): Row => ({
  id: ID,
  number: 12,
  name: 'Анна <b>',
  phone: '+79000000000',
  email: 'anna@example.ru',
  site: 'kofeinya.ru',
  about: 'Цены & новости',
  consentVersion: '2026-10-11',
  createdAt: new Date('2026-11-08T07:41:00Z'),
  telegramMessageId: null,
  sentAt: null,
  processedAt: null,
  ...over,
})

const ok = <T>(result: T): TelegramApiResult<T> => ({ ok: true, result })
const fail = {
  ok: false,
  description: "Bad Request: message can't be deleted",
  errorCode: 400,
} as const

function stand(row: Row | null, updates: TelegramUpdate[] = []) {
  const updates$ = [...updates]
  const bot = {
    sendMessage: vi.fn(async () => ok({ message_id: 77 })),
    getUpdates: vi.fn(async () => ok(updates$.splice(0))),
    deleteMessage: vi.fn(async (): Promise<TelegramApiResult<boolean>> => ok(true)),
    editMessageText: vi.fn(async (): Promise<TelegramApiResult<unknown>> => ok({})),
    answerCallbackQuery: vi.fn(async () => ok(true)),
  }
  const prisma = {
    lead: {
      findUnique: vi.fn(async () => row),
      findMany: vi.fn(async (): Promise<{ id: string; number: number }[]> => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  }
  const lines: string[] = []
  const jobs = new LeadsJobs({
    prisma: prisma as unknown as LeadsJobsDeps['prisma'],
    bot,
    chatId: CHAT,
    logger: { log: (line) => lines.push(line), warn: (line) => lines.push(`warn ${line}`) },
    now: () => NOW,
  })
  return { jobs, bot, prisma, lines }
}

const press = (over: { data?: string; chat?: number; message?: number } = {}): TelegramUpdate => ({
  update_id: 5,
  callback_query: {
    id: 'q1',
    from: { id: 42 },
    data: over.data ?? leadDoneData(ID),
    message: { message_id: over.message ?? 77, chat: { id: over.chat ?? Number(CHAT) } },
  },
})

describe('leadMessage', () => {
  it('escapes every value and names the lead, the time in Moscow and the consent', () => {
    const text = leadMessage(lead())
    expect(text).toContain('<b>Заявка №12</b> · главная, 08.11.2026, 10:41 МСК')
    expect(text).toContain('<b>Имя:</b> Анна &lt;b&gt;')
    expect(text).toContain('<b>Контакт:</b> +79000000000')
    expect(text).not.toContain('Телефон')
    expect(text).toContain('Цены &amp; новости')
    expect(text).toContain('Согласие на обработку данных: да, редакция 2026-10-11')
  })

  it('prints a lead of the two fields without the parts it does not have', () => {
    const text = leadMessage(lead({ name: null, email: null, about: null, phone: '@anna_kofe' }))
    expect(text).toBe(
      [
        '<b>Заявка №12</b> · главная, 08.11.2026, 10:41 МСК',
        '',
        '<b>Контакт:</b> @anna_kofe',
        '<b>Сайт:</b> kofeinya.ru',
        '',
        'Согласие на обработку данных: да, редакция 2026-10-11',
        'Нажмите «Обработано», когда свяжетесь: сообщение удалится из Telegram.',
      ].join('\n'),
    )
  })

  it('keeps every part of a lead written before the form shrank', () => {
    const text = leadMessage(lead())
    expect(text).toContain('<b>Почта:</b> anna@example.ru')
    expect(text).toContain('\n\n<b>Что хочет менять:</b>\nЦены &amp; новости\n\nСогласие')
    expect(text).not.toContain('\n\n\n')
  })

  it('stays within the limit of Telegram for the longest lead', () => {
    const text = leadMessage(
      lead({
        name: '&'.repeat(100),
        email: `${'&'.repeat(240)}@a.ru`,
        site: 'a'.repeat(253),
        about: '<'.repeat(2000),
      }),
    )
    // The longest escape is &amp; (5 characters for 1); still far below 4 096 after parsing.
    expect(text.replace(/&(amp|lt|gt);/g, '&').replace(/<\/?b>/g, '').length).toBeLessThan(4096)
  })

  it('reads back only its own button', () => {
    expect(leadOfDoneData(leadDoneData(ID))).toBe(ID)
    expect(Buffer.byteLength(leadDoneData(ID))).toBeLessThanOrEqual(64)
    for (const other of [undefined, '', 'lead:done:nope', `lead:undo:${ID}`]) {
      expect(leadOfDoneData(other)).toBeNull()
    }
  })
})

describe('LeadsJobs.send', () => {
  it('posts the lead with «Обработано» and records the message', async () => {
    const s = stand(lead())
    await s.jobs.send(ID)

    expect(s.bot.sendMessage).toHaveBeenCalledWith(CHAT, leadMessage(lead()), {
      parseMode: 'HTML',
      inlineKeyboard: [[{ text: 'Обработано', callback_data: `lead:done:${ID}` }]],
    })
    expect(s.prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: ID, telegramMessageId: null },
      data: { telegramMessageId: 77n, sentAt: NOW },
    })
    // The log names the number only.
    expect(s.lines).toEqual(['Lead №12 is posted to Telegram'])
  })

  it('does not post a lead twice', async () => {
    for (const row of [
      lead({ telegramMessageId: 1n }),
      lead({ processedAt: NOW, sentAt: NOW }),
      null,
    ]) {
      const s = stand(row)
      await s.jobs.send(ID)
      expect(s.bot.sendMessage).not.toHaveBeenCalled()
    }
  })

  it('throws on a refusal of Telegram without the text of the lead, for the queue to retry', async () => {
    const s = stand(lead())
    s.bot.sendMessage.mockResolvedValueOnce({
      ok: false,
      description: 'Too Many Requests',
      errorCode: 429,
    } as never)
    await expect(s.jobs.send(ID)).rejects.toThrow(
      'Telegram sendMessage failed: 429 Too Many Requests',
    )
    expect(s.prisma.lead.updateMany).not.toHaveBeenCalled()
  })
})

describe('LeadsJobs.poll', () => {
  it('posts again a lead whose sending gave up, before it reads the presses', async () => {
    const s = stand(lead())
    s.prisma.lead.findMany.mockResolvedValueOnce([{ id: ID, number: 12 }])
    await s.jobs.poll()

    expect(s.prisma.lead.findMany).toHaveBeenCalledWith({
      where: {
        telegramMessageId: null,
        processedAt: null,
        createdAt: { lt: new Date(NOW.getTime() - 10 * 60_000) },
      },
      select: { id: true, number: true },
      orderBy: { createdAt: 'asc' },
      take: 5,
    })
    expect(s.bot.sendMessage).toHaveBeenCalledOnce()
    expect(s.bot.getUpdates).toHaveBeenCalledOnce()
  })

  it('still reads the presses while Telegram refuses to post', async () => {
    const s = stand(lead())
    s.prisma.lead.findMany.mockResolvedValueOnce([{ id: ID, number: 12 }])
    s.bot.sendMessage.mockResolvedValueOnce({
      ok: false,
      description: 'Bad Gateway',
      errorCode: 502,
    } as never)
    await s.jobs.poll()
    expect(s.lines).toContain(
      'warn Lead №12 is still not posted: Telegram sendMessage failed: 502 Bad Gateway',
    )
    expect(s.bot.getUpdates).toHaveBeenCalledOnce()
  })

  it('marks the lead processed, deletes its message and answers the press', async () => {
    const s = stand(lead({ telegramMessageId: 77n, sentAt: NOW }), [press()])
    expect(await s.jobs.poll()).toBe(1)

    expect(s.prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: ID, processedAt: null },
      data: { processedAt: NOW, sentAt: NOW },
    })
    expect(s.bot.deleteMessage).toHaveBeenCalledWith(CHAT, 77)
    expect(s.bot.editMessageText).not.toHaveBeenCalled()
    expect(s.bot.answerCallbackQuery).toHaveBeenCalledWith('q1', 'Заявка обработана')
  })

  it('empties the message when Telegram no longer lets the bot delete it', async () => {
    const s = stand(lead({ telegramMessageId: 77n, sentAt: NOW }), [press()])
    s.bot.deleteMessage.mockResolvedValueOnce(fail)
    await s.jobs.poll()
    expect(s.bot.editMessageText).toHaveBeenCalledWith(CHAT, 77, 'Заявка №12 обработана.')
  })

  it('deletes a second message of a lead that is processed already, without marking it again', async () => {
    const s = stand(lead({ telegramMessageId: 77n, sentAt: NOW, processedAt: NOW }), [
      press({ message: 78 }),
    ])
    await s.jobs.poll()
    expect(s.prisma.lead.updateMany).not.toHaveBeenCalled()
    expect(s.bot.deleteMessage).toHaveBeenCalledWith(CHAT, 78)
  })

  it('takes a press only from the group of leads and only of its own button', async () => {
    for (const update of [press({ chat: -999 }), press({ data: 'other' })]) {
      const s = stand(lead({ telegramMessageId: 77n, sentAt: NOW }), [update])
      await s.jobs.poll()
      expect(s.prisma.lead.updateMany).not.toHaveBeenCalled()
      expect(s.bot.deleteMessage).not.toHaveBeenCalled()
      expect(s.bot.answerCallbackQuery).toHaveBeenCalledWith('q1')
    }
  })

  it('confirms what it read and reads a failed press again', async () => {
    const s = stand(lead({ telegramMessageId: 77n, sentAt: NOW }), [press(), { update_id: 6 }])
    s.prisma.lead.findUnique.mockRejectedValueOnce(new Error('database is away'))
    await expect(s.jobs.poll()).rejects.toThrow('database is away')
    expect(s.bot.getUpdates).toHaveBeenLastCalledWith({
      allowedUpdates: ['callback_query'],
      limit: 100,
    })

    s.bot.getUpdates.mockResolvedValueOnce(ok([press(), { update_id: 6 }]))
    await s.jobs.poll()
    expect(s.bot.deleteMessage).toHaveBeenCalledOnce()

    await s.jobs.poll()
    expect(s.bot.getUpdates).toHaveBeenLastCalledWith({
      offset: 7,
      allowedUpdates: ['callback_query'],
      limit: 100,
    })
  })
})
