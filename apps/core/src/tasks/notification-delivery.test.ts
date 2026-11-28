import { notificationPushPayloadSchema } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LETTER_PAUSE_MS,
  NotificationDelivery,
  PUSH_TIMEOUT_MS,
  PUSH_TTL_SECONDS,
  vapidSubjectOf,
  type Notice,
  type PushAnswer,
  type PushSender,
} from './notification-delivery.ts'

// The channels of a notice (docs/plan/82-scheduled-tasks.md, Зп37–Зп41) over a fake database: the
// SQL of the unique rows is PostgreSQL's, tested in pass-settlement.integration.test.ts.

const NOTICE = '01900000-0000-7000-8000-000000000001'
const CHAT = '01900000-0000-7000-8000-000000000002'
const USER = '01900000-0000-7000-8000-000000000003'
const SCHEDULE = '01900000-0000-7000-8000-000000000004'
const RUN = '01900000-0000-7000-8000-000000000005'
const NOW = new Date('2026-11-16T09:00:00.000Z')
const KEY = 'K'.repeat(87)

afterEach(() => {
  vi.useRealTimers()
})

type Subscription = { id: string; endpoint: string; vapidKey: string | null }

function stand(
  options: {
    inserted?: boolean
    subscriptions?: Subscription[]
    answers?: Record<string, PushAnswer | 'hang' | 'throw'>
    settings?: { email?: boolean; telegram?: boolean; push?: boolean } | null
    verified?: boolean
    recentLetters?: number
    telegram?: boolean
    boundToTelegram?: boolean
  } = {},
) {
  const outbox: { type: string; payload: unknown; dedupeKey?: string }[] = []
  const outboxEvent = {
    createMany: vi.fn(async ({ data }: { data: (typeof outbox)[number][] }) => {
      outbox.push(...data)
      return { count: data.length }
    }),
  }
  const db = {
    chatNotification: {
      createManyAndReturn: vi.fn(async () => (options.inserted === false ? [] : [{ id: NOTICE }])),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => options.recentLetters ?? 0),
    },
    notificationSetting: {
      findUnique: vi.fn(async () => (options.settings === undefined ? null : options.settings)),
    },
    user: {
      findUnique: vi.fn(async () => ({
        email: 'client@example.test',
        emailVerified: options.verified ?? true,
      })),
    },
    pushSubscription: {
      findMany: vi.fn(async () =>
        (options.subscriptions ?? []).map((one) => ({ ...one, p256dh: 'p', auth: 'a' })),
      ),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    channelIdentity: {
      findUnique: vi.fn(async () => (options.telegram ? { externalId: '4242' } : null)),
    },
    task: {
      findUnique: vi.fn(async () => ({
        chatSession: options.boundToTelegram ? { channel: 'telegram' } : null,
      })),
    },
    outboxEvent,
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) =>
      fn({ outboxEvent, chatNotification: db.chatNotification }),
    ),
  }
  const sent: { endpoint: string; payload: string; urgency: string; ttl: number }[] = []
  const push: PushSender = {
    publicKey: KEY,
    send: vi.fn(async (target, payload, opts) => {
      const answer = options.answers?.[target.endpoint] ?? 'sent'
      if (answer === 'hang') return new Promise<PushAnswer>(() => {})
      if (answer === 'throw') throw new Error('push service away')
      sent.push({ endpoint: target.endpoint, payload, urgency: opts.urgency, ttl: opts.ttlSeconds })
      return answer
    }),
  }
  const logger = { log: vi.fn(), warn: vi.fn() }
  const delivery = new NotificationDelivery({
    db: db as never,
    appUrl: 'https://raditi.example',
    push,
    logger,
    now: () => NOW,
  })
  return { db, delivery, sent, outbox, logger }
}

const chatNotice = (patch: Partial<Notice> = {}): Notice => ({
  userId: USER,
  kind: 'answered',
  chat: { taskId: CHAT, attempt: 1, turnNo: 2 },
  schedule: null,
  path: `/chats/${CHAT}`,
  letter: true,
  telegram: { text: 'Агент ответил — чат «Цены».', button: 'Открыть чат' },
  ...patch,
})

const fcm = (n: number) => `https://fcm.googleapis.com/fcm/send/${n}`

describe('NotificationDelivery', () => {
  it('writes the notice once with its pass, and sends nothing for a repeat', async () => {
    const s = stand({
      inserted: false,
      subscriptions: [{ id: 's1', endpoint: fcm(1), vapidKey: KEY }],
    })
    expect(await s.delivery.deliver(chatNotice())).toBe('repeated')
    expect(s.db.chatNotification.createManyAndReturn).toHaveBeenCalledWith({
      data: [
        {
          userId: USER,
          kind: 'answered',
          taskId: CHAT,
          attempt: 1,
          turnNo: 2,
          scheduledTaskId: null,
          scheduledRunId: null,
          artifactId: null,
          actorUserId: null,
          vkCommunityId: null,
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    })
    expect(s.sent).toEqual([])
    expect(s.outbox).toEqual([])
  })

  it('pushes to every browser the client subscribed, whatever the old switch says (Зп37)', async () => {
    const s = stand({
      settings: { push: false, email: false },
      subscriptions: [
        { id: 's1', endpoint: fcm(1), vapidKey: KEY },
        { id: 's2', endpoint: fcm(2), vapidKey: null },
      ],
    })
    expect(await s.delivery.deliver(chatNotice())).toBe('sent')
    expect(s.sent.map((one) => one.endpoint)).toEqual([fcm(1), fcm(2)])
    expect(s.db.chatNotification.update).toHaveBeenCalledWith({
      where: { id: NOTICE },
      data: { pushed: 2 },
    })
  })

  it('carries no word of the chat: the id, the path, the kind, the flag, the tag and the moment (Зп40)', async () => {
    const s = stand({
      settings: { email: false },
      subscriptions: [{ id: 's1', endpoint: fcm(1), vapidKey: KEY }],
    })
    await s.delivery.deliver(chatNotice())
    const payload = JSON.parse(s.sent[0]!.payload)
    expect(payload).toEqual({
      id: NOTICE,
      path: `/chats/${CHAT}`,
      kind: 'answered',
      scheduled: false,
      tag: `chat:${CHAT}`,
      // When `deliver` wrote the row: the worker orders the notices of a tag by it.
      at: NOW.getTime(),
    })
    expect(notificationPushPayloadSchema.safeParse(payload).success).toBe(true)
    expect(s.sent[0]).toMatchObject({ urgency: 'normal', ttl: PUSH_TTL_SECONDS })

    const scheduled = stand({
      settings: { email: false },
      subscriptions: [{ id: 's1', endpoint: fcm(1), vapidKey: KEY }],
    })
    await scheduled.delivery.deliver(
      chatNotice({ kind: 'failed', schedule: { id: SCHEDULE, runId: RUN } }),
    )
    expect(JSON.parse(scheduled.sent[0]!.payload)).toMatchObject({
      scheduled: true,
      tag: `schedule:${SCHEDULE}`,
      kind: 'failed',
    })
    expect(scheduled.sent[0]).toMatchObject({ urgency: 'high', ttl: 24 * 60 * 60 })
  })

  it('forgets a browser that dropped its subscription or was subscribed under another key', async () => {
    const s = stand({
      settings: { email: false },
      subscriptions: [
        { id: 'gone', endpoint: fcm(1), vapidKey: KEY },
        { id: 'old-key', endpoint: fcm(2), vapidKey: 'O'.repeat(87) },
        { id: 'same-key', endpoint: fcm(3), vapidKey: KEY },
        { id: 'unknown-key', endpoint: fcm(4), vapidKey: null },
        { id: 'not-a-push-service', endpoint: 'https://10.10.0.10/x', vapidKey: KEY },
      ],
      answers: {
        [fcm(1)]: 'gone',
        [fcm(2)]: 'forbidden',
        [fcm(3)]: 'forbidden',
        [fcm(4)]: 'forbidden',
      },
    })
    expect(await s.delivery.deliver(chatNotice())).toBe('skipped')
    const deleted = (
      s.db.pushSubscription.deleteMany.mock.calls as unknown as [{ where: { id: string } }][]
    ).map(([args]) => args.where.id)
    expect(deleted.sort()).toEqual(['gone', 'not-a-push-service', 'old-key'])
    // A 403 under the key of now may be a fault of ours: the browser stays, the log says so.
    expect(s.logger.warn).toHaveBeenCalledWith(expect.stringContaining('chat_push_forbidden'))
  })

  it('gives up a push service that does not answer in 10 s, and the others go on', async () => {
    vi.useFakeTimers()
    const s = stand({
      settings: { email: false },
      subscriptions: [
        { id: 's1', endpoint: fcm(1), vapidKey: KEY },
        { id: 's2', endpoint: fcm(2), vapidKey: KEY },
        { id: 's3', endpoint: fcm(3), vapidKey: KEY },
      ],
      answers: { [fcm(1)]: 'hang', [fcm(2)]: 'throw' },
    })
    const delivered = s.delivery.deliver(chatNotice())
    await vi.advanceTimersByTimeAsync(PUSH_TIMEOUT_MS)
    expect(await delivered).toBe('sent')
    expect(s.sent.map((one) => one.endpoint)).toEqual([fcm(3)])
    expect(s.db.chatNotification.update).toHaveBeenCalledWith({
      where: { id: NOTICE },
      data: { pushed: 1 },
    })
  })

  it('writes a letter with a link only, at most once in half an hour per chat or task', async () => {
    const s = stand()
    expect(await s.delivery.deliver(chatNotice({ telegram: null }))).toBe('sent')
    expect(s.outbox).toEqual([
      {
        topic: 'notifications',
        type: 'chat.waiting',
        payload: {
          to: 'client@example.test',
          kind: 'answered',
          url: `https://raditi.example/chats/${CHAT}`,
          settingsUrl: 'https://raditi.example/settings',
        },
        dedupeKey: `chat.waiting:${NOTICE}`,
        availableAt: undefined,
      },
    ])
    expect(s.db.chatNotification.count).toHaveBeenCalledWith({
      where: {
        userId: USER,
        emailed: true,
        createdAt: { gt: new Date(NOW.getTime() - LETTER_PAUSE_MS) },
        taskId: CHAT,
      },
    })

    const task = stand()
    await task.delivery.deliver(
      chatNotice({
        kind: 'not_started',
        chat: null,
        schedule: { id: SCHEDULE, runId: RUN },
        path: `/scheduled/${SCHEDULE}`,
        telegram: null,
      }),
    )
    expect(task.outbox[0]?.payload).toEqual({
      to: 'client@example.test',
      kind: 'not_started',
      scheduled: true,
      url: `https://raditi.example/scheduled/${SCHEDULE}`,
      settingsUrl: 'https://raditi.example/settings',
    })
    expect(task.db.chatNotification.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ scheduledTaskId: SCHEDULE }),
    })

    for (const quiet of [
      stand({ recentLetters: 1 }),
      stand({ verified: false }),
      stand({ settings: { email: false } }),
    ]) {
      expect(await quiet.delivery.deliver(chatNotice({ telegram: null }))).toBe('skipped')
      expect(quiet.outbox).toEqual([])
    }
    const noLetter = stand()
    await noLetter.delivery.deliver(chatNotice({ letter: false, telegram: null }))
    expect(noLetter.outbox).toEqual([])
  })

  it('tells a client who linked Telegram, unless the chat is bound to Telegram', async () => {
    const s = stand({ telegram: true, settings: { email: false } })
    expect(await s.delivery.deliver(chatNotice())).toBe('sent')
    expect(s.outbox).toEqual([
      expect.objectContaining({
        topic: 'telegram',
        type: 'telegram.send',
        payload: {
          chatId: '4242',
          text: 'Агент ответил — чат «Цены».',
          buttons: [[{ text: 'Открыть чат', url: `https://raditi.example/chats/${CHAT}` }]],
        },
      }),
    ])
    const bound = stand({ telegram: true, boundToTelegram: true, settings: { email: false } })
    expect(await bound.delivery.deliver(chatNotice())).toBe('skipped')
    const off = stand({ telegram: true, settings: { email: false, telegram: false } })
    expect(await off.delivery.deliver(chatNotice())).toBe('skipped')
  })
})

describe('vapidSubjectOf (Зп41)', () => {
  it('signs with the cabinet over https, and with the platform’s site in dev', () => {
    expect(vapidSubjectOf('https://raditi.ru')).toBe('https://raditi.ru')
    expect(vapidSubjectOf('http://localhost:3000')).toBe('https://raditi.ru')
  })
})
