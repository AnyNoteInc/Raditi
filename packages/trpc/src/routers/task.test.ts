import { randomUUID } from 'node:crypto'

import type { PrismaClient, User } from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { createCaller } from '../router.ts'
import { releaseConfirmKey, type ChatContext } from '../services/chat/context.ts'
import type { Context } from '../trpc.ts'

// The procedures of a dialog against a database that holds nothing of the user: what is
// refused before any row is read or written. Their transactions run on PostgreSQL in
// chat-db.test.ts.

const now = new Date('2026-10-17T12:00:00Z')
const user: User = {
  id: randomUUID(),
  name: 'Анна',
  lastName: null,
  email: 'dialog-unit@example.ru',
  emailVerified: true,
  image: null,
  createdAt: now,
  updatedAt: now,
}
const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)
const chat: ChatContext = {
  appEnv: 'test',
  preview: { address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 }, ttlHours: 72 },
  releaseConfirmKey: releaseConfirmKey('unit test secret'),
  storage: () => ({}) as ObjectStorage,
  secrets: () => ({}) as SecretStore,
}

/** Consents are accepted; nothing else of the user exists, and no transaction may start. */
function emptyDb() {
  const db = {
    userConsent: { findMany: vi.fn().mockResolvedValue(requiredConsents) },
    task: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    site: { findFirst: vi.fn().mockResolvedValue(null) },
    taskCandidate: { findFirst: vi.fn().mockResolvedValue(null) },
    previewEnvironment: { findFirst: vi.fn().mockResolvedValue(null) },
    siteRelease: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn(async () => {
      throw new Error('no transaction is expected')
    }),
  }
  return { db, prisma: db as unknown as PrismaClient }
}

function callerOf(prisma: PrismaClient, dialogs: ChatContext | null = chat) {
  const context: Context = {
    prisma,
    headers: new Headers(),
    user,
    session: {
      id: randomUUID(),
      userId: user.id,
      token: 'dialog-unit-session',
      expiresAt: new Date('2030-01-01'),
      createdAt: now,
      updatedAt: now,
      ipAddress: null,
      userAgent: null,
    },
    billing: null,
    chat: dialogs,
  }
  return createCaller(context)
}

const ids = { siteId: randomUUID(), taskId: randomUUID() }

describe('the words of a new dialog', () => {
  it.each([
    ['', 'TASK_TEXT_EMPTY', 'Напишите, что нужно сделать на сайте'],
    ['​ ', 'TASK_TEXT_EMPTY', 'Напишите, что нужно сделать на сайте'],
    [
      'я'.repeat(4001),
      'TASK_TEXT_TOO_LONG',
      'Сообщение слишком длинное — сократите его до 4000 знаков',
    ],
    [
      'Пароль от админки: Qwerty123456',
      'TASK_TEXT_HAS_SECRET',
      'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Настройки»',
    ],
  ])('are refused before the database is read: %j', async (text, code, message) => {
    const { db, prisma } = emptyDb()

    await expect(callerOf(prisma).task.create({ ...ids, text })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message,
      cause: { code },
    })
    expect(db.task.findUnique).not.toHaveBeenCalled()
    expect(db.site.findFirst).not.toHaveBeenCalled()
  })

  it('are refused the same way in a dialog that waits', async () => {
    const { db, prisma } = emptyDb()
    await expect(
      callerOf(prisma).task.message({
        taskId: ids.taskId,
        requestId: randomUUID(),
        text: `токен ghp_${'a'.repeat(36)}`,
      }),
    ).rejects.toMatchObject({ cause: { code: 'TASK_TEXT_HAS_SECRET' } })
    expect(db.task.findFirst).not.toHaveBeenCalled()
  })
})

describe('a dialog of someone else', () => {
  it('answers every procedure as a site that does not exist', async () => {
    const { db, prisma } = emptyDb()
    const caller = callerOf(prisma)
    const requestId = randomUUID()
    const calls = [
      caller.task.create({ ...ids, text: 'Поменяйте телефон' }),
      caller.task.message({ taskId: ids.taskId, requestId, text: 'Да' }),
      caller.task.continue({ taskId: ids.taskId, requestId }),
      caller.task.retry({ taskId: ids.taskId, requestId, failureEventId: '17' }),
      caller.task.cancel({ taskId: ids.taskId, requestId }),
      caller.task.commands({ taskId: ids.taskId }),
      caller.task.list({ siteId: ids.siteId }),
      caller.candidate.get({ taskId: ids.taskId }),
      caller.candidate.update({ taskId: ids.taskId, requestId }),
      caller.preview.ticket({ taskId: ids.taskId }),
      caller.preview.reset({ taskId: ids.taskId }),
      caller.release.prepare({ taskId: ids.taskId }),
    ]
    for (const refusal of await Promise.all(
      calls.map((call) => call.catch((error: unknown) => error)),
    ))
      expect(refusal).toMatchObject({ code: 'NOT_FOUND', message: 'Не нашли то, что вы ищете' })
    expect(db.$transaction).not.toHaveBeenCalled()
  })
})

describe('dialogs that are not set up', () => {
  it('answer that dialogs are unavailable for what needs the services of the app', async () => {
    const { prisma } = emptyDb()
    await expect(
      callerOf(prisma, null).task.create({ ...ids, text: 'Поменяйте телефон' }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Диалоги сейчас недоступны. Попробуйте ещё раз немного позже',
      cause: { code: 'CHAT_NOT_CONFIGURED' },
    })
  })

  it('refuse a release confirmation that is not one before the database is read', async () => {
    const { db, prisma } = emptyDb()
    await expect(
      callerOf(prisma).release.confirm({
        taskId: ids.taskId,
        confirmToken: 'x.y',
        version: 'v1.0.0',
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: 'Не удалось подтвердить выпуск. Откройте выпуск версии заново',
    })
    expect(db.task.findFirst).not.toHaveBeenCalled()
  })
})
