import { randomUUID } from 'node:crypto'

import { markProjectFileReady, createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { TRPCError } from '@trpc/server'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'

// The files and texts of the context of a project on PostgreSQL (docs/plan/84-projects.md, ПР8;
// slice 84.8): `projectFile.*`, `project.create({ fileIds })` and the room of a project. The bytes
// of an upload are web's (`PUT /api/project-files/<id>`): here a file is marked ready as web does.

const databaseUrl = process.env.DATABASE_URL
const MIB = 1024 * 1024

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

function v7(): string {
  const random = randomUUID().replaceAll('-', '')
  const hex = `${Date.now().toString(16).padStart(12, '0')}7${random.slice(13, 16)}8${random.slice(17)}`
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function refusal(act: () => Promise<unknown>): Promise<{ code: string; text: string }> {
  try {
    await act()
  } catch (error) {
    if (error instanceof TRPCError) {
      const cause = error.cause as { code?: string } | undefined
      return { code: cause?.code ?? error.code, text: error.message }
    }
    throw error
  }
  throw new Error('The procedure was not refused')
}

/** raditi-inbox in memory. */
function memoryInbox() {
  const objects = new Map<string, Uint8Array>()
  const storage = {
    async put(_bucket: string, key: string, body: Uint8Array | AsyncIterable<Uint8Array>) {
      if (body instanceof Uint8Array) objects.set(key, body)
      else {
        const chunks: Uint8Array[] = []
        for await (const chunk of body) chunks.push(chunk)
        objects.set(key, Buffer.concat(chunks))
      }
    },
    async delete(_bucket: string, key: string) {
      objects.delete(key)
    },
    async get(_bucket: string, key: string) {
      const bytes = objects.get(key)
      return bytes
        ? (async function* () {
            yield bytes
          })()
        : null
    },
  } as unknown as ObjectStorage
  return { objects, storage }
}

describe.skipIf(!databaseUrl)('PostgreSQL: the files of the context of a project', () => {
  let db: PrismaClient
  const userIds: string[] = []
  const inbox = memoryInbox()

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const users = userIds.splice(0)
    const workspaces = await db.workspace.findMany({
      where: { createdById: { in: users } },
      select: { id: true },
    })
    const owned = { workspaceId: { in: workspaces.map(({ id }) => id) } }
    await db.projectFile.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.project.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function owner() {
    const user: User = await db.user.create({
      data: { name: 'Project files verification', email: `${randomUUID()}@projects.example.ru` },
    })
    userIds.push(user.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: user.id, source: 'sign_up' })),
    })
    const chat: ChatContext = {
      appEnv: 'test',
      browser: null,
      storage: () => inbox.storage,
      secrets: () => ({ transitEnsureKey: async () => {} }) as unknown as SecretStore as never,
    }
    const caller = createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `project-files-test-${randomUUID()}`,
        expiresAt: new Date('2030-01-01'),
        createdAt: new Date(),
        updatedAt: new Date(),
        ipAddress: null,
        userAgent: null,
      },
      billing: null,
      chat,
    })
    /** A file announced and stored, as web marks it after the upload. */
    const uploaded = async (
      name: string,
      size = 10,
      type = 'application/pdf',
      projectId?: string,
    ) => {
      const started = await caller.projectFile.start({
        name,
        size,
        type,
        ...(projectId ? { projectId } : {}),
      })
      expect(
        await markProjectFileReady(db, {
          id: started.fileId,
          sizeBytes: size,
          sha256: 'b'.repeat(64),
        }),
      ).toBe(true)
      return started
    }
    return { user, caller, uploaded }
  }

  it('announces a file of a folder and refuses what the rules refuse, in the client words', async () => {
    const { caller } = await owner()
    const started = await caller.projectFile.start({
      name: 'Фото\\Зима/витрина.jpg',
      size: 100,
      type: 'image/jpeg',
    })
    expect(started).toMatchObject({ name: 'Фото/Зима/витрина.jpg' })
    expect(started.uploadPath).toBe(`/api/project-files/${started.fileId}`)
    expect(
      await refusal(() => caller.projectFile.start({ name: '.env', size: 5, type: 'text/plain' })),
    ).toMatchObject({
      code: 'PROJECT_FILE_REFUSED',
      text: expect.stringContaining('Такой файл в проект добавить нельзя'),
    })
    expect(
      await refusal(() =>
        caller.projectFile.start({ name: '../a.pdf', size: 5, type: 'application/pdf' }),
      ),
    ).toMatchObject({
      code: 'PROJECT_FILE_REFUSED',
      text: expect.stringContaining('Путь к файлу слишком длинный'),
    })
    expect(
      await refusal(() =>
        caller.projectFile.start({ name: 'a.pdf', size: 21 * MIB, type: 'application/pdf' }),
      ),
    ).toMatchObject({
      code: 'PROJECT_FILE_REFUSED',
    })
    // A project of someone else is not found.
    expect(
      await refusal(() =>
        caller.projectFile.start({
          name: 'a.pdf',
          size: 5,
          type: 'application/pdf',
          projectId: v7(),
        }),
      ),
    ).toMatchObject({ code: 'PROJECT_NOT_FOUND' })
  })

  it('creates a project with its files in one transaction; a repeat takes nothing again', async () => {
    const { caller, uploaded } = await owner()
    const a = await uploaded('Брендбук.pdf')
    const b = await uploaded('Брендбук.pdf')
    const pending = await caller.projectFile.start({
      name: 'Прайс.pdf',
      size: 10,
      type: 'application/pdf',
    })
    const projectId = v7()
    // A file not stored yet refuses the whole creation: no project is left.
    expect(
      await refusal(() =>
        caller.project.create({ projectId, name: 'Пекарня', fileIds: [a.fileId, pending.fileId] }),
      ),
    ).toMatchObject({ code: 'PROJECT_FILE_NOT_READY' })
    expect(await db.project.count({ where: { id: projectId } })).toBe(0)
    const input = { projectId, name: 'Пекарня', fileIds: [a.fileId, b.fileId] }
    expect(await caller.project.create(input)).toEqual({ projectId, created: true })
    expect(await caller.project.create(input)).toEqual({ projectId, created: false })
    const listed = await caller.projectFile.list({ projectId })
    expect(listed.files.map((file) => file.name)).toEqual(['Брендбук (2).pdf', 'Брендбук.pdf'])
    expect(listed).toMatchObject({ bytes: 20, limitBytes: 100 * MIB, percent: 1 })
    const project = await caller.project.get({ projectId })
    expect(project.files).toMatchObject({ count: 2, bytes: 20 })
  })

  it('adds a text as a .md file, refuses a secret, and binds, lists and removes files', async () => {
    const { caller, uploaded } = await owner()
    const projectId = v7()
    await caller.project.create({ projectId, name: 'Тексты' })
    expect(
      await refusal(() =>
        caller.projectFile.addText({ projectId, title: 'Доступы', text: 'Пароль: Qwerty123' }),
      ),
    ).toMatchObject({ code: 'PROJECT_TEXT_HAS_SECRET' })
    const text = await caller.projectFile.addText({
      projectId,
      title: 'Тон бренда',
      text: '# Тон\nПишем на «вы».',
    })
    expect(text.name).toBe('Тон бренда.md')
    const row = await db.projectFile.findUniqueOrThrow({ where: { id: text.fileId } })
    expect(row).toMatchObject({
      kind: 'text',
      mediaType: 'text/markdown',
      status: 'ready',
      projectId,
    })
    expect(new TextDecoder().decode(inbox.objects.get(row.s3Key))).toBe('# Тон\nПишем на «вы».')
    // A second text of the same title becomes «(2)».
    expect(
      (await caller.projectFile.addText({ projectId, title: 'Тон бренда', text: 'Ещё' })).name,
    ).toBe('Тон бренда (2).md')
    const later = await uploaded('Фото/витрина.jpg', 30, 'image/jpeg', projectId)
    expect(await caller.projectFile.bind({ projectId, fileIds: [later.fileId] })).toEqual({
      bound: 1,
    })
    expect((await caller.projectFile.list({ projectId })).files).toHaveLength(3)
    await caller.projectFile.remove({ projectId, fileId: text.fileId })
    expect(inbox.objects.has(row.s3Key)).toBe(false)
    expect((await caller.projectFile.list({ projectId })).files.map((file) => file.name)).toEqual([
      'Тон бренда (2).md',
      'Фото/витрина.jpg',
    ])
    // A file of the project is not removed as one without a project, and the other way round.
    expect(
      await refusal(() => caller.projectFile.remove({ projectId: null, fileId: later.fileId })),
    ).toMatchObject({
      code: 'PROJECT_FILE_NOT_FOUND',
    })
    const loose = await uploaded('Черновик.pdf')
    await caller.projectFile.remove({ projectId: null, fileId: loose.fileId })
  })

  it('keeps the room of a project: the 101st MiB is refused before the upload', async () => {
    const { caller, uploaded } = await owner()
    const projectId = v7()
    await caller.project.create({ projectId, name: 'Большой' })
    for (let i = 0; i < 5; i++) {
      const file = await uploaded(`part-${i}.pdf`, 20 * MIB, 'application/pdf', projectId)
      await caller.projectFile.bind({ projectId, fileIds: [file.fileId] })
    }
    expect(
      await refusal(() =>
        caller.projectFile.start({ name: 'more.pdf', size: 1, type: 'application/pdf', projectId }),
      ),
    ).toMatchObject({ code: 'PROJECT_SPACE_FULL', text: expect.stringContaining('до 100 МБ') })
    expect(
      await refusal(() => caller.projectFile.addText({ projectId, title: 'x', text: 'y' })),
    ).toMatchObject({ code: 'PROJECT_SPACE_FULL' })
    // Someone else's project and its files are not seen.
    const other = await owner()
    expect(await refusal(() => other.caller.projectFile.list({ projectId }))).toMatchObject({
      code: 'PROJECT_NOT_FOUND',
    })
  })
})
