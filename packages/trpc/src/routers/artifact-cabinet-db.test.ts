import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'

// The procedures of artifacts in the cabinet on PostgreSQL (docs/plan/88-artifacts.md, stage Э4):
// the gallery and «Создать» (88.9). Every test works in workspaces of its own and removes them.

const databaseUrl = process.env.DATABASE_URL

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

/** A random UUID with the version 7 in its place. */
const v7 = () => {
  const id = randomUUID()
  return `${id.slice(0, 14)}7${id.slice(15)}`
}

describe.skipIf(!databaseUrl)('PostgreSQL: artifacts in the cabinet', () => {
  let db: PrismaClient
  const userIds: string[] = []

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
    await db.pageReservation.deleteMany({ where: { page: owned } })
    await db.page.deleteMany({ where: owned })
    await db.pageTree.deleteMany({ where: owned })
    await db.artifact.deleteMany({ where: owned })
    await db.task.deleteMany({ where: owned })
    await db.project.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.member.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function person(name = 'Анна'): Promise<User> {
    const row = await db.user.create({
      data: { name, email: `${randomUUID()}@artifacts-cabinet.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  function callerOf(user: User) {
    const chat: ChatContext = {
      appEnv: 'test',
      browser: null,
      storage: () => ({ get: async () => null }) as unknown as ObjectStorage,
      secrets: () => ({ transitEnsureKey: async () => {} }) as unknown as SecretStore,
      artifacts: null,
    }
    return createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `artifacts-cabinet-${randomUUID()}`,
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

  async function projectOf(user: User) {
    const { id: workspaceId } = await db.workspace.findFirstOrThrow({
      where: { createdById: user.id },
      select: { id: true },
    })
    return db.project.create({
      // A UUID of version 7, as the window «Создание проекта» makes it (CHECK projects_id_check).
      data: { id: v7(), workspaceId, createdById: user.id, name: 'Пекарня' },
    })
  }

  it('creates from a template, lists by filters and words, trashes and restores (88.9)', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const offer = await caller.artifact.create({
      kind: 'document',
      title: 'Предложение для кафе',
      projectId: null,
      templateId: 'offer',
    })
    const project = await projectOf(anna)
    const plain = await caller.artifact.create({
      kind: 'document',
      title: 'Заметки',
      projectId: project.id,
      templateId: null,
    })
    const all = await caller.artifact.list({ filter: 'all' })
    expect(all.map((row) => row.id).sort()).toEqual([offer.id, plain.id].sort())
    const made = all.find((row) => row.id === offer.id)!
    expect(made).toMatchObject({ kind: 'document', project: null, blocks: 4 })
    expect(made.excerpt).toContain('Коротко о задаче клиента')
    expect((await caller.artifact.list({ filter: 'mine' })).map((row) => row.id)).toEqual([
      offer.id,
    ])
    expect((await caller.artifact.list({ filter: 'projects' })).map((row) => row.id)).toEqual([
      plain.id,
    ])
    expect(await caller.artifact.list({ filter: 'shared' })).toEqual([])
    // A word of the text finds it, not only of the title.
    expect(
      (await caller.artifact.list({ filter: 'all', query: 'предложение действует' })).map(
        (row) => row.id,
      ),
    ).toEqual([offer.id])

    const { purgeAfter } = await caller.artifact.trash({ artifactId: offer.id })
    expect(new Date(purgeAfter).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000)
    expect((await caller.artifact.list({ filter: 'all' })).map((row) => row.id)).toEqual([plain.id])
    expect((await caller.artifact.list({ filter: 'trash' }))[0]).toMatchObject({
      id: offer.id,
      purgeAfter,
    })
    expect(await caller.artifact.restore({ artifactId: offer.id })).toBe(true)
    expect(await caller.artifact.list({ filter: 'trash' })).toEqual([])

    // Another person sees none of it, and may not touch it.
    const boris = callerOf(await person('Борис'))
    expect(await boris.artifact.list({ filter: 'all' })).toEqual([])
    await expect(boris.artifact.trash({ artifactId: offer.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    // A project of someone else is no place for an artifact.
    await expect(
      boris.artifact.create({
        kind: 'document',
        title: 'Чужое',
        projectId: project.id,
        templateId: null,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('refuses a kind whose view has not shipped (Ар7)', async () => {
    const caller = callerOf(await person())
    await expect(
      caller.artifact.create({ kind: 'canvas', title: 'Холст', projectId: null, templateId: null }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
})
