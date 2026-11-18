import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { createPrismaClient, insertFeedEvent, type PrismaClient } from '@repo/db'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { TaskSignalRelay } from './task-signal-relay.ts'

// The signals of chats on PostgreSQL (migration 20261109110000_task_signals): a change is said
// once its transaction commits, never before and never for one rolled back.

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: the signals of a chat', () => {
  let db: PrismaClient
  let relay: TaskSignalRelay
  let userId: string
  let workspaceId: string
  let taskId: string
  const published: [string, string][] = []

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    const user = await db.user.create({
      data: { name: 'Signals', email: `${randomUUID()}@signals.example.ru` },
    })
    userId = user.id
    workspaceId = (
      await db.$transaction((tx) => ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }))
    ).id
    taskId = (
      await db.task.create({
        data: {
          workspaceId,
          createdById: userId,
          status: 'awaiting_user',
          title: 'Сигналы',
          needsBrowser: true,
        },
        select: { id: true },
      })
    ).id
    relay = new TaskSignalRelay({
      listener: () => new pg.Client({ connectionString: databaseUrl }),
      publish: async (channel, message) => {
        published.push([channel, message])
      },
      logger: { log: () => undefined, warn: () => undefined },
      coalesceMs: 10,
    })
    relay.start()
    await until(() => published.some(([channel]) => channel === 'raditi:tasks:resync'))
  })
  afterAll(async () => {
    await relay?.stop()
    await db.task.deleteMany({ where: { workspaceId } })
    await db.creditLedger.deleteMany({ where: { account: { workspaceId } } })
    await db.billingAccount.deleteMany({ where: { workspaceId } })
    await db.member.deleteMany({ where: { workspaceId } })
    await db.workspace.deleteMany({ where: { id: workspaceId } })
    await db.user.deleteMany({ where: { id: userId } })
    await db.$disconnect()
  })

  async function until(done: () => boolean, ms = 5_000) {
    const deadline = Date.now() + ms
    while (!done()) {
      if (Date.now() > deadline) throw new Error('no signal in time')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  const ofTask = () => published.filter(([channel]) => channel === `raditi:task:${taskId}`)
  const words = () =>
    ({
      type: 'feed.request',
      payload: { v: 1, kind: 'first', authorId: userId, requestId: randomUUID(), text: 'Слова' },
    }) as const

  it('says a row of the feed once its transaction has committed', async () => {
    published.length = 0
    const committing = Promise.withResolvers<void>()
    const written = Promise.withResolvers<void>()
    const transaction = db.$transaction(async (tx) => {
      await insertFeedEvent(tx, { taskId, row: words() })
      written.resolve()
      await committing.promise
    })
    await written.promise
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(ofTask()).toEqual([])
    committing.resolve()
    await transaction
    await until(() => ofTask().length > 0)
    expect(ofTask()).toEqual([[`raditi:task:${taskId}`, 'feed']])
  })

  it('says nothing of a transaction rolled back', async () => {
    published.length = 0
    await expect(
      db.$transaction(async (tx) => {
        await insertFeedEvent(tx, { taskId, row: words() })
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(ofTask()).toEqual([])
  })

  it('wakes the outbox relay once rows of the outbox commit', async () => {
    let woken = 0
    const outboxRelay = new TaskSignalRelay({
      listener: () => new pg.Client({ connectionString: databaseUrl }),
      publish: async () => undefined,
      outbox: () => {
        woken += 1
      },
      logger: { log: () => undefined, warn: () => undefined },
    })
    outboxRelay.start()
    try {
      await until(() => woken === 1)
      const dedupeKey = `signals-test:${randomUUID()}`
      await db.outboxEvent.createMany({
        data: [1, 2, 3].map((n) => ({
          topic: 'notifications',
          type: 'test.wake',
          payload: { n },
          dedupeKey: `${dedupeKey}:${n}`,
        })),
      })
      // One statement of three rows: one wake.
      await until(() => woken === 2)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(woken).toBe(2)
      await db.outboxEvent.deleteMany({ where: { dedupeKey: { startsWith: dedupeKey } } })
    } finally {
      await outboxRelay.stop()
    }
  })

  it('says the agent output of a turn and a change of the task by their kinds', async () => {
    published.length = 0
    await db.taskEvent.create({
      data: { taskId, type: 'turn.output', payload: { turn: 1, events: [] } },
    })
    await db.task.update({ where: { id: taskId }, data: { title: 'Сигналы, второй' } })
    await until(() => ofTask().length >= 2)
    expect(
      ofTask()
        .map(([, kind]) => kind)
        .sort(),
    ).toEqual(['activity', 'feed'])
  })
})
