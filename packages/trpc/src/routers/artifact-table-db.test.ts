import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'

// The table of an artifact in the cabinet on PostgreSQL (docs/plan/88-artifacts.md, §7.7, §7.13,
// question 26; slice 88.14): a table from a template, its card in the gallery, the totals of the
// server, «Скачать → Excel» — a row and its job for core — and a table published as a page to read.
// Every test works in workspaces of its own and removes them.

const databaseUrl = process.env.DATABASE_URL

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

describe.skipIf(!databaseUrl)('PostgreSQL: the table of an artifact in the cabinet', () => {
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
    await db.outboxEvent.deleteMany({ where: { type: 'artifact.export' } })
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
      pages: { baseDomain: 'pages.localhost', scheme: 'http', port: 3110 },
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

  it('makes a price list of the template, sums it on the server and shows it in words', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const { id } = await caller.artifact.create({
      kind: 'table',
      title: 'Прайс-лист',
      projectId: null,
      templateId: 'price-list',
    })
    const read = await caller.artifact.read({ artifactId: id })
    expect(read.blocks.map((block) => block.kind)).toEqual(['columns', 'row', 'row', 'row'])
    const [card] = await caller.artifact.list({ filter: 'all' })
    expect(card!.excerpt).toContain('Название · Категория')
    expect(card!.excerpt).toContain('[Товар] · Товары · шт · 990')
    expect(await caller.artifact.tableTotals({ artifactId: id, rows: null })).toEqual({
      totals: { price: '2790.00' },
      rows: 3,
    })
    const first = read.blocks[1]!.key
    expect(await caller.artifact.tableTotals({ artifactId: id, rows: [first] })).toEqual({
      totals: { price: '990.00' },
      rows: 1,
    })
    // A cell that does not fit its column is refused whole.
    await expect(
      caller.artifact.write({
        batch: {
          artifactId: id,
          opId: randomUUID(),
          ops: [{ op: 'cells', block: first, cells: { price: 'дорого' } }],
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const boris = callerOf(await person('Борис'))
    await expect(boris.artifact.tableTotals({ artifactId: id, rows: null })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('asks core for the workbook with one row and one job, for its owner only', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const { id } = await caller.artifact.create({
      kind: 'table',
      title: 'Контент-план',
      projectId: null,
      templateId: 'content-plan',
    })
    const { exportId } = await caller.artifact.exportStart({ artifactId: id })
    expect(await caller.artifact.exportStatus({ exportId })).toEqual({ state: 'pending' })
    const jobs = await db.outboxEvent.findMany({
      where: {
        topic: 'artifacts',
        type: 'artifact.export',
        dedupeKey: `artifact.export:${exportId}`,
      },
    })
    expect(jobs).toHaveLength(1)
    const boris = callerOf(await person('Борис'))
    await expect(boris.artifact.exportStart({ artifactId: id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(boris.artifact.exportStatus({ exportId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    // A document has no workbook.
    const doc = await caller.artifact.create({
      kind: 'document',
      title: 'Заметки',
      projectId: null,
      templateId: null,
    })
    await expect(caller.artifact.exportStart({ artifactId: doc.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    // At most three wait at once.
    await caller.artifact.exportStart({ artifactId: id })
    await caller.artifact.exportStart({ artifactId: id })
    await expect(caller.artifact.exportStart({ artifactId: id })).rejects.toMatchObject({
      code: 'CONFLICT',
    })
  })

  it('publishes a table as a page to read: its columns and rows as a table', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const { id } = await caller.artifact.create({
      kind: 'table',
      title: 'Прайс-лист',
      projectId: null,
      templateId: 'price-list',
    })
    const page = await caller.pages.publishArtifact({ artifactId: id, versionNo: null })
    const stored = await db.pageContent.findUniqueOrThrow({ where: { pageId: page.pageId } })
    const html = Buffer.from(stored.bytes).toString('utf8')
    expect(html).toContain('<table')
    expect(html).toContain('[Товар]')
    expect(html).toContain('990 ₽')
  })
})
