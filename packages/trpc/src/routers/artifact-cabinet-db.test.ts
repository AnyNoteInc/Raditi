import { randomUUID } from 'node:crypto'

import {
  applyArtifactOps,
  attachMentionedArtifacts,
  claimArtifactBlock,
  createPrismaClient,
  settleArtifactWrites,
  type PrismaClient,
  type User,
} from '@repo/db'
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

  it('reads, writes in the canonical form, holds, takes back and lists its chats (88.10)', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const { id } = await caller.artifact.create({
      kind: 'document',
      title: 'Тексты',
      projectId: null,
      templateId: null,
    })
    const { workspaceId } = await db.artifact.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true },
    })
    const task = await db.task.create({
      data: { workspaceId, createdById: anna.id, title: 'Тексты для сайта' },
      select: { id: true },
    })
    const agent = { kind: 'agent' as const, taskId: task.id, turnNo: 1 }
    // The agent writes in its own manner: «*» bullets and an underscore.
    await applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [
          {
            op: 'insert',
            block: 'dostavka',
            after: null,
            kind: 'section',
            content: '* по городу\n* _бесплатно_ от 2000 ₽',
            props: { heading: 'Доставка' },
          },
        ],
      },
      actor: agent,
    })
    // Until core checked it, the person reads nothing of it and may not hold it.
    const waiting = await caller.artifact.read({ artifactId: id })
    expect(waiting.blocks[0]).toMatchObject({ key: 'dostavka', content: null, checking: true })
    await expect(caller.artifact.hold({ artifactId: id, block: 'dostavka' })).rejects.toMatchObject(
      { code: 'CONFLICT' },
    )
    const rev = waiting.blocks[0]!.rev
    await settleArtifactWrites(db, {
      taskId: task.id,
      blocks: [{ artifactId: id, block: 'dostavka', rev, refusal: null }],
      final: true,
    })
    const read = await caller.artifact.read({ artifactId: id })
    expect(read).toMatchObject({ role: 'owner', project: null, title: 'Тексты' })
    expect(read.blocks[0]).toMatchObject({
      heading: 'Доставка',
      content: '* по городу\n* _бесплатно_ от 2000 ₽',
      checking: false,
      hold: null,
    })
    const held = await caller.artifact.hold({ artifactId: id, block: 'dostavka' })
    expect(held.rev).toBe(read.blocks[0]!.rev)
    // An agent gets the block held by the person.
    await expect(
      applyArtifactOps(db, {
        batch: {
          artifactId: id,
          opId: randomUUID(),
          ops: [{ op: 'edit', block: 'dostavka', find: 'по городу', replace: 'по области' }],
        },
        actor: { ...agent, turnNo: 2 },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_BLOCK_HELD' })
    // The person's first save: the agent's text is brought to the canonical form first, then the
    // person's word — two revisions, the second changes one line.
    const saved = await caller.artifact.write({
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [
          {
            op: 'replace',
            block: 'dostavka',
            ifRev: read.blocks[0]!.rev,
            content: '- по всему городу\n- *бесплатно* от 2000 ₽',
            props: { heading: 'Доставка' },
          },
        ],
      },
    })
    expect(saved.blocks[0]!.rev).toBe(read.blocks[0]!.rev + 2)
    const revisions = await db.artifactBlockRevision.findMany({
      where: { artifactId: id, blockKey: 'dostavka' },
      orderBy: { rev: 'asc' },
      select: { rev: true, content: true, writtenByUserId: true },
    })
    expect(revisions.slice(-2).map((each) => each.content)).toEqual([
      '- по городу\n- *бесплатно* от 2000 ₽\n',
      '- по всему городу\n- *бесплатно* от 2000 ₽\n',
    ])
    // A stale revision is refused with the block as it is.
    await expect(
      caller.artifact.write({
        batch: {
          artifactId: id,
          opId: randomUUID(),
          ops: [{ op: 'replace', block: 'dostavka', ifRev: 1, content: 'старое' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    // The agent claims a block; «Забрать правку» takes it back.
    await caller.artifact.release({ artifactId: id, block: 'dostavka' })
    await claimArtifactBlock(db, {
      artifactId: id,
      block: 'dostavka',
      actor: { ...agent, turnNo: 3 },
      intent: 'Допишу про самовывоз',
    })
    expect((await caller.artifact.read({ artifactId: id })).blocks[0]!.hold).toBe('claim')
    await expect(caller.artifact.hold({ artifactId: id, block: 'dostavka' })).rejects.toMatchObject(
      { code: 'CONFLICT' },
    )
    await caller.artifact.take({ artifactId: id, block: 'dostavka' })
    expect((await caller.artifact.read({ artifactId: id })).blocks[0]!.hold).toBe('human')
    // A secret is never kept.
    await expect(
      caller.artifact.write({
        batch: {
          artifactId: id,
          opId: randomUUID(),
          ops: [
            {
              op: 'insert',
              after: 'dostavka',
              kind: 'section',
              content: 'пароль ghp_0123456789abcdefghijABCDEFGHIJ012345',
              props: { heading: 'Ключ' },
            },
          ],
        },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    // Its chats: only the reader's own.
    expect((await caller.artifact.chats({ artifactId: id })).map((chat) => chat.taskId)).toEqual([
      task.id,
    ])
    const named = await caller.artifact.saveVersion({ artifactId: id, label: 'Показала маме' })
    expect(named.no).toBeGreaterThan(0)
    // Another person reads nothing.
    const boris = callerOf(await person('Борис'))
    await expect(boris.artifact.read({ artifactId: id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(boris.artifact.chats({ artifactId: id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('lists the artifacts of a chat by group, attaching those the client mentions (88.11)', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const made = await caller.artifact.create({
      kind: 'document',
      title: 'Сделан',
      projectId: null,
      templateId: null,
    })
    const named = await caller.artifact.create({
      kind: 'document',
      title: 'Назван',
      projectId: null,
      templateId: null,
    })
    const { workspaceId } = await db.artifact.findUniqueOrThrow({
      where: { id: made.id },
      select: { workspaceId: true },
    })
    const task = await db.task.create({
      data: { workspaceId, createdById: anna.id, title: 'Чат' },
      select: { id: true },
    })
    await db.artifactChat.create({ data: { artifactId: made.id, taskId: task.id, how: 'created' } })
    // Someone else's artifact is never attached by its id.
    const boris = await person('Борис')
    const foreign = await callerOf(boris).artifact.create({
      kind: 'document',
      title: 'Чужой',
      projectId: null,
      templateId: null,
    })
    expect(
      await attachMentionedArtifacts(db, {
        taskId: task.id,
        artifactIds: [named.id, foreign.id, made.id],
      }),
    ).toEqual([named.id])
    expect(
      (await caller.artifact.ofChat({ taskId: task.id })).map((row) => [row.title, row.group]),
    ).toEqual([
      ['Сделан', 'made'],
      ['Назван', 'mentioned'],
    ])
    await expect(callerOf(boris).artifact.ofChat({ taskId: task.id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
