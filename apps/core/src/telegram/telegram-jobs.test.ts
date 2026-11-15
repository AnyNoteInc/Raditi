import { UnrecoverableError } from 'bullmq'
import { describe, expect, it, vi } from 'vitest'

import { TELEGRAM_UPDATE_TRIES, TelegramJobs, type TelegramJobsDeps } from './telegram-jobs.ts'

const TASK = '019a8f00-0000-7000-8000-000000000001'
const TURN = '019a8f00-0000-7000-8000-000000000002'

type Update = { update_id: number }

/** The tables TelegramJobs reads, in memory, and a Bot API that records what it is asked. */
function harness(options: {
  updates?: Update[]
  taken?: number[]
  session?: { externalChatId: string | null; telegramTopicId: number | null } | null
  events?: { id: bigint; type: string; payload: unknown }[]
  topics?: boolean
  /** The Telegram account of the chat was unlinked since. */
  unlinked?: boolean
  web?: (update: Update) => number
  send?: (body: Record<string, unknown>) => {
    ok: boolean
    errorCode?: number
    description?: string
  }
}) {
  const taken = new Set((options.taken ?? []).map(BigInt))
  const session =
    options.session === null
      ? null
      : {
          id: 's1',
          channel: 'telegram',
          ...(options.session ?? { externalChatId: '42', telegramTopicId: null }),
        }
  const sent: { chatId: string; text: string; threadId?: number; keyboard?: unknown }[] = []
  const posted: number[] = []
  const prisma = {
    telegramUpdate: {
      findFirst: vi.fn(async () => {
        const max = [...taken].sort((a, b) => (a < b ? 1 : -1))[0]
        return max === undefined ? null : { updateId: max }
      }),
      createMany: vi.fn(async ({ data }: { data: { updateId: bigint }[] }) => {
        for (const row of data) taken.add(row.updateId)
        return { count: data.length }
      }),
      deleteMany: vi.fn(async () => ({ count: 0 })),
    },
    task: {
      findUnique: vi.fn(async () => ({
        deletedAt: null,
        title: 'Заголовок',
        chatSession: session,
      })),
      findUniqueOrThrow: vi.fn(async () => ({ siteId: null })),
    },
    taskTurn: { findUnique: vi.fn(async () => ({ id: TURN })) },
    taskEvent: {
      findMany: vi.fn(async () =>
        (options.events ?? []).map((event) => ({
          ...event,
          createdAt: new Date('2026-11-15T09:00:00Z'),
        })),
      ),
    },
    channelIdentity: {
      findUnique: vi.fn(async () => (options.unlinked ? null : { userId: 'u1' })),
    },
    chatSession: {
      updateMany: vi.fn(async ({ data }: { data: { telegramTopicId: number } }) => {
        if (session) session.telegramTopicId = data.telegramTopicId
        return { count: 1 }
      }),
    },
  }
  const bot = {
    call: vi.fn(async (_method: string, body: Record<string, unknown> | undefined) => {
      const offset = (body?.offset as number | undefined) ?? 0
      return {
        ok: true as const,
        result: (options.updates ?? []).filter((u) => u.update_id >= offset),
      }
    }),
    getMe: vi.fn(async () => ({
      ok: true as const,
      result: {
        id: 1,
        is_bot: true,
        first_name: 'Радити',
        has_topics_enabled: options.topics ?? false,
      },
    })),
    sendMessage: vi.fn(
      async (chatId: number | string, text: string, opts: Record<string, unknown> = {}) => {
        const answer = options.send?.({ chatId, text, ...opts }) ?? { ok: true }
        if (!answer.ok)
          return {
            ok: false as const,
            description: answer.description ?? 'Bad Request',
            errorCode: answer.errorCode,
          }
        sent.push({
          chatId: String(chatId),
          text,
          ...(opts.threadId === undefined ? {} : { threadId: opts.threadId as number }),
          ...(opts.inlineKeyboard === undefined ? {} : { keyboard: opts.inlineKeyboard }),
        })
        return { ok: true as const, result: { message_id: sent.length } }
      },
    ),
    answerCallbackQuery: vi.fn(async () => ({ ok: true as const, result: true })),
    createForumTopic: vi.fn(async () => ({
      ok: true as const,
      result: { message_thread_id: 77, name: 'Заголовок' },
    })),
  }
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const update = JSON.parse(String(init?.body)) as Update
    posted.push(update.update_id)
    expect((init?.headers as Record<string, string>)['x-telegram-bot-api-secret-token']).toBe(
      's'.repeat(40),
    )
    const status = options.web?.(update) ?? 200
    if (status === 200) taken.add(BigInt(update.update_id))
    return new Response('{}', { status })
  })
  const jobs = new TelegramJobs({
    prisma: prisma as unknown as TelegramJobsDeps['prisma'],
    bot: bot as unknown as TelegramJobsDeps['bot'],
    intake: { url: 'http://web:3000/api/webhooks/telegram', secret: 's'.repeat(40) },
    appUrl: 'https://raditi.example.ru',
    fetch: fetch as unknown as typeof globalThis.fetch,
    logger: { log: vi.fn(), warn: vi.fn() },
  })
  return { jobs, prisma, bot, sent, posted, taken }
}

describe('TelegramJobs.poll', () => {
  it('asks Telegram for the updates after the largest one taken and posts each to web in order', async () => {
    const h = harness({
      updates: [{ update_id: 10 }, { update_id: 11 }, { update_id: 12 }],
      taken: [10],
    })
    expect(await h.jobs.poll()).toBe(2)
    expect(h.bot.call).toHaveBeenCalledWith(
      'getUpdates',
      expect.objectContaining({
        offset: 11,
        timeout: 0,
        allowed_updates: ['message', 'callback_query'],
      }),
      expect.anything(),
    )
    expect(h.posted).toEqual([11, 12])
  })

  it('waits for web as long as it is away, and gives up only an update web cannot read', async () => {
    let away = true
    const h = harness({
      updates: [{ update_id: 5 }, { update_id: 6 }],
      web: () => (away ? 503 : 200),
    })
    // A deploy or the database away: the words of the client wait, however many ticks it takes.
    for (let i = 0; i < TELEGRAM_UPDATE_TRIES * 3; i++) expect(await h.jobs.poll()).toBe(0)
    expect(h.taken.has(5n)).toBe(false)
    away = false
    expect(await h.jobs.poll()).toBe(2)

    const broken = harness({
      updates: [{ update_id: 7 }, { update_id: 8 }],
      web: (u) => (u.update_id === 7 ? 400 : 200),
    })
    for (let i = 1; i < TELEGRAM_UPDATE_TRIES; i++) expect(await broken.jobs.poll()).toBe(0)
    // The last answer keeps it as taken, so the next ones go on.
    expect(await broken.jobs.poll()).toBe(1)
    expect(broken.taken.has(7n)).toBe(true)
    expect(broken.posted.at(-1)).toBe(8)
  })
})

describe('TelegramJobs.send', () => {
  it('sends the words escaped, to the topic of the task, after the spinner of the press', async () => {
    const h = harness({ session: { externalChatId: '42', telegramTopicId: 9 } })
    await h.jobs.send({
      chatId: '42',
      taskId: TASK,
      text: 'a <b> & c',
      pressId: 'p1',
      buttons: [[{ text: 'Остановить', data: `stop:${TASK}` }]],
    })
    expect(h.bot.answerCallbackQuery).toHaveBeenCalledWith('p1')
    expect(h.sent).toEqual([
      {
        chatId: '42',
        text: 'a &lt;b&gt; &amp; c',
        threadId: 9,
        keyboard: [[{ text: 'Остановить', callback_data: `stop:${TASK}` }]],
      },
    ])
  })

  it('gives up a client who blocked the bot and sends without a topic Telegram lost', async () => {
    const blocked = harness({
      send: () => ({
        ok: false,
        errorCode: 403,
        description: 'Forbidden: bot was blocked by the user',
      }),
    })
    await expect(blocked.jobs.send({ chatId: '42', text: 'x' })).rejects.toBeInstanceOf(
      UnrecoverableError,
    )
    const lost = harness({
      session: { externalChatId: '42', telegramTopicId: 9 },
      send: (body) =>
        body.threadId === 9
          ? { ok: false, errorCode: 400, description: 'Bad Request: message thread not found' }
          : { ok: true },
    })
    await lost.jobs.send({ chatId: '42', taskId: TASK, text: 'x' })
    expect(lost.sent).toEqual([{ chatId: '42', text: 'x' }])
  })
})

describe('TelegramJobs.deliver', () => {
  const result = {
    id: 1n,
    type: 'feed.result',
    payload: {
      v: 1,
      turn: 2,
      message: 'Поменял **заголовок**.',
      site: 'changed',
      next: 'done',
      filesChanged: null,
      changeType: 'content',
      needsApproval: false,
      risk: 'low',
    },
  }

  it('sends the rows of the pass in the words of the cabinet, with the way to the chat', async () => {
    const h = harness({ events: [result] })
    expect(await h.jobs.deliver({ taskId: TASK, kind: 'answered', attempt: 1, turnNo: 2 })).toBe(
      'sent',
    )
    expect(h.prisma.taskEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ turnId: TURN, clientVisible: true }),
      }),
    )
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('Поменял <b>заголовок</b>.')
    expect(h.sent[0]!.keyboard).toEqual([
      [{ text: 'Открыть в кабинете', url: `https://raditi.example.ru/chats/${TASK}` }],
    ])
  })

  it('offers «Продолжить» for the question of the ceiling and skips a chat not bound to Telegram', async () => {
    const h = harness({
      events: [
        {
          id: 2n,
          type: 'feed.question',
          payload: { v: 1, kind: 'ceiling', turn: 3, reason: 'step', spent: 12, held: 15, left: 3 },
        },
      ],
    })
    await h.jobs.deliver({ taskId: TASK, kind: 'limit', attempt: 1, turnNo: 3 })
    expect(h.sent.at(-1)?.keyboard).toEqual([
      [{ text: 'Продолжить', callback_data: `go:${TASK}` }],
      [{ text: 'Открыть в кабинете', url: `https://raditi.example.ru/chats/${TASK}` }],
    ])
    // A Telegram account unlinked since gets nothing of the chat (rule 1).
    const unlinked = harness({ unlinked: true, events: [result] })
    expect(
      await unlinked.jobs.deliver({ taskId: TASK, kind: 'answered', attempt: 1, turnNo: 2 }),
    ).toBe('skipped')
    expect(unlinked.sent).toEqual([])
    const unbound = harness({ session: null, events: [result] })
    expect(
      await unbound.jobs.deliver({ taskId: TASK, kind: 'answered', attempt: 1, turnNo: 2 }),
    ).toBe('skipped')
    expect(unbound.sent).toEqual([])
  })
})

describe('TelegramJobs.topic', () => {
  it('opens a topic for a chat of a bot with topics and keeps it, once', async () => {
    const h = harness({ topics: true })
    expect(await h.jobs.topic({ taskId: TASK })).toBe('opened')
    expect(h.bot.createForumTopic).toHaveBeenCalledWith('42', 'Заголовок')
    expect(h.sent[0]).toMatchObject({ threadId: 77, text: 'Чат «Заголовок». Отвечу здесь.' })
    expect(await h.jobs.topic({ taskId: TASK })).toBe('skipped')
  })

  it('opens none when the bot has no topics in private chats', async () => {
    const h = harness({ topics: false })
    expect(await h.jobs.topic({ taskId: TASK })).toBe('skipped')
    expect(h.bot.createForumTopic).not.toHaveBeenCalled()
  })
})
