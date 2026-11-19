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
  status?: string
  /** The events of the journal of the turn (`turn.output`). */
  output?: unknown[]
  progressId?: number | null
  edit?: (text: string) => { ok: boolean; description?: string }
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
          telegramProgressId: options.progressId ?? (null as number | null),
          telegramProgressChain: null as string | null,
          ...(options.session ?? { externalChatId: '42', telegramTopicId: null }),
        }
  const edits: { messageId: number; text: string }[] = []
  const deleted: number[] = []
  const later: { chain?: string; tick?: number }[] = []
  const gone: unknown[] = []
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
      findUniqueOrThrow: vi.fn(async () => ({
        siteId: null,
        status: options.status ?? 'running',
        chatSession: session,
      })),
    },
    taskTurn: { findUnique: vi.fn(async () => ({ id: TURN })) },
    taskEvent: {
      findFirst: vi.fn(async ({ where }: { where: { type: string } }) =>
        where.type === 'turn.output'
          ? options.output === undefined
            ? null
            : { payload: { events: options.output } }
          : { createdAt: new Date(Date.now() - 65_000) },
      ),
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
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (session) Object.assign(session, data)
        return session
      }),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { telegramProgressChain?: string }
          data: Record<string, unknown>
        }) => {
          if (!session) return { count: 0 }
          if (
            where.telegramProgressChain !== undefined &&
            session.telegramProgressChain !== where.telegramProgressChain
          )
            return { count: 0 }
          Object.assign(session, data)
          return { count: 1 }
        },
      ),
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
    editMessageText: vi.fn(async (_chat: string, messageId: number, text: string) => {
      const answer = options.edit?.(text) ?? { ok: true }
      if (!answer.ok)
        return {
          ok: false as const,
          description: answer.description ?? 'Bad Request',
          errorCode: 400,
        }
      edits.push({ messageId, text })
      return { ok: true as const, result: true }
    }),
    deleteMessage: vi.fn(async (_chat: string, messageId: number) => {
      deleted.push(messageId)
      return { ok: true as const, result: true }
    }),
    sendChatAction: vi.fn(async () => ({ ok: true as const, result: true })),
    deleteForumTopic: vi.fn(async () => ({ ok: true as const, result: true })),
    createForumTopic: vi.fn(async () => ({
      ok: true as const,
      result: { message_thread_id: 77, name: 'Заголовок' },
    })),
  }
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const update = JSON.parse(String(init?.body)) as Update & { raditi_topic_gone?: unknown }
    if (update.raditi_topic_gone !== undefined) {
      gone.push(update.raditi_topic_gone)
      return new Response('{}', { status: 200 })
    }
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
    later: async (job) => {
      later.push(job)
    },
  })
  return { jobs, prisma, bot, sent, posted, taken, session, edits, deleted, later, gone }
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
    // The client deleted the topic in Telegram: web is told, so the chat goes in the cabinet too.
    const lost = harness({
      session: { externalChatId: '42', telegramTopicId: 9 },
      send: (body) =>
        body.threadId === 9
          ? { ok: false, errorCode: 400, description: 'Bad Request: message thread not found' }
          : { ok: true },
    })
    await lost.jobs.send({ chatId: '42', taskId: TASK, text: 'x' })
    expect(lost.sent).toEqual([])
    expect(lost.gone).toEqual([{ chat_id: '42', thread_id: 9 }])
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

  it('tells the rows of memory too (docs/plan/84-projects.md, ПР18)', async () => {
    const h = harness({
      events: [
        result,
        {
          id: 3n,
          type: 'feed.memory_change',
          payload: {
            v: 1,
            action: 'proposed',
            entryId: '0199a3f2-0000-7000-8000-0000000e0001',
            kind: 'preference',
            text: 'Блоки сезонных товаров — под шапкой',
          },
        },
      ],
    })
    await h.jobs.deliver({ taskId: TASK, kind: 'answered', attempt: 1, turnNo: 2 })
    expect(h.prisma.taskEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: { in: expect.arrayContaining(['feed.memory_change', 'feed.memory_left']) },
        }),
      }),
    )
    expect(h.sent.at(-1)?.text).toContain(
      'Агент предлагает запомнить: Блоки сезонных товаров — под шапкой',
    )
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

describe('TelegramJobs.deliver of a row told alone (docs/plan/82-scheduled-tasks.md, Зп35)', () => {
  it('sends only that row, keeps the message of the work, and finds no row of another kind', async () => {
    const h = harness({ progressId: 9 })
    h.prisma.taskEvent.findFirst.mockResolvedValueOnce({
      id: 31n,
      type: 'feed.schedule_left',
      payload: { v: 1, action: 'create', name: 'Сводка заявок', reason: 'limit' },
      createdAt: new Date('2026-11-15T09:00:00Z'),
    } as never)
    expect(
      await h.jobs.deliver({
        taskId: TASK,
        kind: 'answered',
        attempt: 1,
        turnNo: 2,
        eventId: '31',
      }),
    ).toBe('sent')
    expect(h.prisma.taskEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 31n,
          taskId: TASK,
          clientVisible: true,
          type: { in: ['feed.schedule_change', 'feed.schedule_left'] },
        },
      }),
    )
    // The rows of the pass are not read again, and the message of the next pass stands.
    expect(h.prisma.taskEvent.findMany).not.toHaveBeenCalled()
    expect(h.bot.deleteMessage).not.toHaveBeenCalled()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toContain('Задачу не удалось сохранить')
    expect(h.sent[0]!.keyboard).toEqual([
      [{ text: 'Открыть в кабинете', url: `https://raditi.example.ru/chats/${TASK}` }],
    ])

    const none = harness({})
    none.prisma.taskEvent.findFirst.mockResolvedValueOnce(null as never)
    expect(
      await none.jobs.deliver({
        taskId: TASK,
        kind: 'answered',
        attempt: 1,
        turnNo: 2,
        eventId: '32',
      }),
    ).toBe('skipped')
    expect(none.sent).toEqual([])
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

describe('TelegramJobs.progress', () => {
  const search = [{ type: 'tool_call', tool: 'raditi_search_web', ok: true }]

  it('sends the message of the work once, then edits it with what the agent does, every few seconds', async () => {
    const h = harness({ output: search })
    expect(await h.jobs.progress({ taskId: TASK })).toBe('ticked')
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0]!.text).toMatch(/Агент работает · 1 мин 0[45] с\nИщет в интернете/u)
    expect(h.session!.telegramProgressId).toBe(1)
    expect(h.bot.sendChatAction).toHaveBeenCalledWith('42', 'typing', undefined)
    const next = h.later.at(-1)!
    expect(next).toMatchObject({ taskId: TASK, tick: 1, chain: h.session!.telegramProgressChain })
    expect(await h.jobs.progress({ taskId: TASK, ...next })).toBe('ticked')
    expect(h.sent).toHaveLength(1)
    expect(h.edits).toEqual([{ messageId: 1, text: expect.stringMatching(/Ищет в интернете/u) }])
  })

  it('says the plan of the work when the agent last wrote its list, escaped (docs/plan/87, ТД9)', async () => {
    const h = harness({
      output: [
        ...search,
        {
          type: 'todo_list',
          items: [
            { text: 'Собрали цены', status: 'completed' },
            { text: 'Сверяем <цены> & скидки', status: 'in_progress' },
            { text: 'Публикуем страницу', status: 'pending' },
          ],
        },
        {
          type: 'usage',
          usage: { inputUncached: 10, cacheRead: 0, cacheWrite: 0, output: 2, reasoning: 0 },
        },
      ],
    })
    expect(await h.jobs.progress({ taskId: TASK })).toBe('ticked')
    expect(h.sent[0]!.text).toMatch(
      /\nПлан: сделано 1 из 3 · сейчас: Сверяем &lt;цены&gt; &amp; скидки$/u,
    )
  })

  it('stops an older run when a newer one takes the message over, and deletes the message when the pass ends', async () => {
    const h = harness({ output: search })
    await h.jobs.progress({ taskId: TASK })
    const older = h.later.at(-1)!
    await h.jobs.progress({ taskId: TASK })
    expect(await h.jobs.progress({ taskId: TASK, ...older })).toBe('skipped')
    const done = harness({ status: 'awaiting_user', progressId: 5 })
    done.session!.telegramProgressChain = '019a8f00-0000-7000-8000-0000000000cc'
    expect(
      await done.jobs.progress({
        taskId: TASK,
        chain: '019a8f00-0000-7000-8000-0000000000cc',
        tick: 3,
      }),
    ).toBe('stopped')
    expect(done.deleted).toEqual([5])
    expect(done.later).toEqual([])
  })

  it('deletes the message of the work before the answer of the pass', async () => {
    const h = harness({
      progressId: 3,
      events: [
        {
          id: 1n,
          type: 'feed.result',
          payload: {
            v: 1,
            turn: 2,
            message: 'Готово.',
            site: 'changed',
            next: 'done',
            filesChanged: null,
            changeType: 'content',
            needsApproval: false,
            risk: 'low',
          },
        },
      ],
    })
    h.session!.telegramProgressChain = '019a8f00-0000-7000-8000-0000000000dd'
    await h.jobs.deliver({ taskId: TASK, kind: 'answered', attempt: 1, turnNo: 2 })
    expect(h.deleted).toEqual([3])
    expect(h.session!.telegramProgressChain).toBeNull()
    expect(h.sent.at(-1)?.text).toContain('Готово.')
  })
})

describe('TelegramJobs.forget', () => {
  it('deletes the topic of a chat deleted in the cabinet, and lets a gone topic be', async () => {
    const h = harness({})
    expect(await h.jobs.forget({ chatId: '42', threadId: 9 })).toBe('deleted')
    expect(h.bot.deleteForumTopic).toHaveBeenCalledWith('42', 9)
    h.bot.deleteForumTopic.mockResolvedValueOnce({
      ok: false,
      description: 'Bad Request: message thread not found',
      errorCode: 400,
    } as never)
    expect(await h.jobs.forget({ chatId: '42', threadId: 9 })).toBe('skipped')
  })
})
