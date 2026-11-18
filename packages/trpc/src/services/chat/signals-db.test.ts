import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, type ObjectStorage, type TaskSignal } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../../router.ts'
import type { ChatContext } from './context.ts'
import type { TaskSignals } from './signals.ts'

// `task.signals` through the router on PostgreSQL: the stream of a chat for a member of its
// workspace, NOT_FOUND for anyone else, and nothing at all where Redis is not set up.

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: the stream of signals of a chat', () => {
  let db: PrismaClient
  let owner: User
  let stranger: User
  let workspaceId: string
  let taskId: string
  const listeners = new Set<(signal: TaskSignal) => void>()
  const signals: TaskSignals = {
    subscribe: (_taskId, listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }

  async function person(): Promise<User> {
    const user = await db.user.create({
      data: { name: 'Signals', email: `${randomUUID()}@signals-db.example.ru` },
    })
    await db.userConsent.createMany({
      data: legalDocuments.flatMap((document) =>
        document.required && document.consentType
          ? [
              {
                userId: user.id,
                documentType: document.consentType,
                documentVersion: document.version,
                granted: true,
                source: 'sign_up' as const,
              },
            ]
          : [],
      ),
    })
    return user
  }

  function callerOf(user: User, withSignals = true) {
    const chat: ChatContext = {
      appEnv: 'test',
      browser: null,
      storage: () => ({}) as ObjectStorage,
      secrets: () => ({}) as ReturnType<ChatContext['secrets']>,
      signals: withSignals ? signals : null,
    }
    return createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `signals-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat,
    })
  }

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    owner = await person()
    stranger = await person()
    workspaceId = (
      await db.$transaction((tx) =>
        ensurePersonalWorkspaceWithGift(tx, { userId: owner.id, appEnv: 'test' }),
      )
    ).id
    taskId = (
      await db.task.create({
        data: {
          workspaceId,
          createdById: owner.id,
          status: 'awaiting_user',
          title: 'Сигналы',
          needsBrowser: true,
        },
        select: { id: true },
      })
    ).id
  })
  afterAll(async () => {
    await db.task.deleteMany({ where: { workspaceId } })
    await db.creditLedger.deleteMany({ where: { account: { workspaceId } } })
    await db.billingAccount.deleteMany({ where: { workspaceId } })
    await db.member.deleteMany({ where: { workspaceId } })
    await db.workspace.deleteMany({ where: { id: workspaceId } })
    await db.user.deleteMany({ where: { id: { in: [owner.id, stranger.id] } } })
    await db.$disconnect()
  })

  it('streams resync and then the signals of the chat to its member, until the page goes', async () => {
    const stream = await callerOf(owner).task.signals({ taskId })
    const iterator = stream[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toEqual({ signal: 'resync' })
    const next = iterator.next()
    for (const listener of listeners) listener('feed')
    expect((await next).value).toEqual({ signal: 'feed' })
    // The page goes: the stream stops listening.
    await iterator.return?.(undefined)
    expect(listeners.size).toBe(0)
  })

  it('refuses the chat to someone else, and streams nothing where Redis is not set up', async () => {
    const refused = (await callerOf(stranger).task.signals({ taskId }))[Symbol.asyncIterator]()
    await expect(refused.next()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const none = (await callerOf(owner, false).task.signals({ taskId }))[Symbol.asyncIterator]()
    expect((await none.next()).done).toBe(true)
  })
})
