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
  browser: { streamUrl: 'ws://localhost:8091/v1/browser/stream' },
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
    attachment: { count: vi.fn().mockResolvedValue(0) },
    // A conditional write that finds no row of the user.
    $queryRaw: vi.fn().mockResolvedValue([]),
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
      'Похоже, в сообщении есть пароль или ключ. Не отправляйте их в чат — доступы задаются в разделе «Переменные»',
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
      caller.task.activity({ taskId: ids.taskId, turn: 1 }),
      caller.task.list({ siteId: ids.siteId }),
      caller.candidate.get({ taskId: ids.taskId }),
      caller.candidate.update({ taskId: ids.taskId, requestId }),
      caller.preview.ticket({ taskId: ids.taskId }),
      caller.preview.reset({ taskId: ids.taskId }),
      caller.release.prepare({ taskId: ids.taskId }),
      caller.task.resumeAgent({ taskId: ids.taskId, requestId }),
      caller.browser.streamTicket({ taskId: ids.taskId }),
      caller.attachment.list({ taskId: ids.taskId }),
      caller.attachment.bind({ taskId: ids.taskId, attachmentIds: [randomUUID()] }),
      caller.attachment.remove({ attachmentId: randomUUID() }),
      caller.attachment.start({
        siteId: ids.siteId,
        name: 'photo.jpg',
        size: 2048,
        type: 'image/jpeg',
      }),
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

describe('the environment of a new dialog', () => {
  it('refuses requirements that need nothing and files given twice, before anything is read', async () => {
    const { db, prisma } = emptyDb()
    const attachment = randomUUID()
    const calls = [
      callerOf(prisma).task.create({
        ...ids,
        text: 'Добавьте новость',
        requirements: { repository: false, browser: false },
      }),
      callerOf(prisma).task.create({
        ...ids,
        text: 'Добавьте новость',
        attachments: [attachment, attachment.toUpperCase()],
      }),
      callerOf(prisma).task.create({
        ...ids,
        text: 'Добавьте новость',
        attachments: Array.from({ length: 11 }, () => randomUUID()),
      }),
    ]
    for (const refusal of await Promise.all(
      calls.map((call) => call.catch((error: unknown) => error)),
    ))
      expect(refusal).toMatchObject({ code: 'BAD_REQUEST' })
    expect(db.task.findUnique).not.toHaveBeenCalled()
    expect(db.site.findFirst).not.toHaveBeenCalled()
  })
})

describe('the key of the workspace of a new dialog (docs/plan/57, Б32)', () => {
  const workspaceId = randomUUID()
  /** A site added by «Добавить проект» for the browser alone: no repository, still onboarding. */
  const browserSite = (dataClass: 'synthetic' | 'client' = 'synthetic') => ({
    id: ids.siteId,
    workspaceId,
    status: 'onboarding',
    url: 'https://example.ru',
    alias: 'kofe',
    workspace: { dataClass },
    provisioningStages: [],
    gitRepositories: [],
  })
  function withVault(transitEnsureKey: ReturnType<typeof vi.fn>): ChatContext {
    const secrets = { transitEnsureKey } as unknown as SecretStore
    return { ...chat, preview: null, secrets: () => secrets }
  }

  it('is made before the transaction that writes the task, once, under the name of the workspace', async () => {
    const { db, prisma } = emptyDb()
    db.site.findFirst.mockResolvedValue(browserSite())
    const created = { taskId: ids.taskId, alias: 'zakaz', created: true }
    db.$transaction.mockResolvedValueOnce(created as never)
    const ensure = vi.fn().mockResolvedValue(undefined)

    await expect(
      callerOf(prisma, withVault(ensure)).task.create({ ...ids, text: 'Добавьте новость' }),
    ).resolves.toEqual(created)
    expect(ensure).toHaveBeenCalledExactlyOnceWith(`ws-${workspaceId}`)
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(
      db.$transaction.mock.invocationCallOrder[0]!,
    )
  })

  it('refuses the task when Vault fails, and writes nothing: no task, no reserve', async () => {
    const { db, prisma } = emptyDb()
    db.site.findFirst.mockResolvedValue(browserSite())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const failure = Object.assign(new Error('permission denied hvs.private-token'), {
      name: 'VaultError',
      status: 403,
    })
    const ensure = vi.fn().mockRejectedValue(failure)

    await expect(
      callerOf(prisma, withVault(ensure)).task.create({ ...ids, text: 'Добавьте новость' }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message:
        'Не удалось начать задание из-за технического сбоя. Попробуйте ещё раз немного позже',
      cause: { code: 'WORKSPACE_KEY_UNAVAILABLE' },
    })
    expect(ensure).toHaveBeenCalledOnce()
    expect(db.$transaction).not.toHaveBeenCalled()
    // The log names the workspace and the class of the failure, never what Vault said.
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      `workspace_key_failed workspace=${workspaceId} error=VaultError status=403`,
    )
    warn.mockRestore()
  })

  it('refuses the task the same way when the settings of Vault do not parse', async () => {
    const { db, prisma } = emptyDb()
    db.site.findFirst.mockResolvedValue(browserSite())
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const broken: ChatContext = {
      ...chat,
      preview: null,
      secrets: () => {
        throw new Error('Invalid vault configuration: VAULT_ADDR is required')
      },
    }

    await expect(
      callerOf(prisma, broken).task.create({ ...ids, text: 'Добавьте новость' }),
    ).rejects.toMatchObject({ cause: { code: 'WORKSPACE_KEY_UNAVAILABLE' } })
    expect(db.$transaction).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('is not asked for by a task that is refused or delivered before', async () => {
    const ensure = vi.fn().mockResolvedValue(undefined)
    const refused = emptyDb()
    refused.db.site.findFirst.mockResolvedValue(browserSite('client'))
    await expect(
      callerOf(refused.prisma, withVault(ensure)).task.create({ ...ids, text: 'Добавьте новость' }),
    ).rejects.toMatchObject({ cause: { code: 'TASK_NOT_ACCEPTED' } })

    const repeated = emptyDb()
    repeated.db.task.findUnique.mockResolvedValue({
      siteId: ids.siteId,
      createdById: user.id,
      alias: 'zakaz',
    })
    await expect(
      callerOf(repeated.prisma, withVault(ensure)).task.create({
        ...ids,
        text: 'Добавьте новость',
      }),
    ).resolves.toEqual({ taskId: ids.taskId, alias: 'zakaz', created: false })

    expect(ensure).not.toHaveBeenCalled()
  })
})

describe('the stream of the browser of a task', () => {
  it('answers that the browser is unavailable where the platform has none, before reading', async () => {
    const { db, prisma } = emptyDb()
    await expect(
      callerOf(prisma, { ...chat, browser: null }).browser.streamTicket({ taskId: ids.taskId }),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Работа в браузере сейчас недоступна. Попробуйте ещё раз немного позже',
      cause: { code: 'BROWSER_UNAVAILABLE' },
    })
    expect(db.task.findFirst).not.toHaveBeenCalled()
  })
})

describe('a file announced for a message', () => {
  it.each([
    [{ name: 'photo.exe', type: 'image/jpeg' }, 'type_not_allowed', 'Такой файл прикрепить нельзя'],
    // The extension of the name decides the type: a PDF called a picture is refused.
    [{ name: 'report.pdf', type: 'image/png' }, 'type_not_allowed', 'Такой файл прикрепить нельзя'],
    [{ name: '\u202e', type: 'image/jpeg' }, 'empty', 'Файл пустой или без имени'],
    [{ size: 0 }, 'empty', 'Файл пустой или без имени'],
    [{ size: 20 * 1024 * 1024 + 1 }, 'too_large', 'Файл больше 20 МБ'],
  ])('is refused by the rules before the database is read: %j', async (file, reason, start) => {
    const { db, prisma } = emptyDb()
    const refusal = await callerOf(prisma)
      .attachment.start({
        siteId: ids.siteId,
        name: 'photo.jpg',
        size: 2048,
        type: 'image/jpeg',
        ...file,
      })
      .catch((error: unknown) => error)
    expect(refusal).toMatchObject({
      code: 'BAD_REQUEST',
      cause: { code: 'ATTACHMENT_REFUSED', details: { reason } },
    })
    expect((refusal as Error).message.startsWith(start)).toBe(true)
    expect((refusal as Error).message.endsWith('.')).toBe(false)
    expect(db.site.findFirst).not.toHaveBeenCalled()
  })

  it('needs the dialogs of the process: nothing could store it otherwise', async () => {
    const { db, prisma } = emptyDb()
    await expect(
      callerOf(prisma, null).attachment.start({
        siteId: ids.siteId,
        name: 'photo.jpg',
        size: 2048,
        type: 'image/jpeg',
      }),
    ).rejects.toMatchObject({ cause: { code: 'CHAT_NOT_CONFIGURED' } })
    expect(db.site.findFirst).not.toHaveBeenCalled()
  })
})
