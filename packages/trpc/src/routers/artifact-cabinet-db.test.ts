import { randomUUID } from 'node:crypto'

import { placeReserve } from '@repo/billing/testing'
import {
  addAgentCommentReply,
  applyArtifactOps,
  attachMentionedArtifacts,
  claimArtifactBlock,
  createPrismaClient,
  dropAgentCommentReplies,
  dropStaleAgentCommentReplies,
  insertFeedEvent,
  operatorArtifactDecision,
  readArtifactComments,
  readChatArtifactComments,
  settleAgentCommentReplies,
  settleArtifactWrites,
  type Prisma,
  type PrismaClient,
  type User,
} from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { artifactLimits } from '@repo/domain/artifacts'
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
  const dispatchChatIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const chats = dispatchChatIds.splice(0)
    if (chats.length > 0) {
      await db.outboxEvent.deleteMany({
        where: { OR: chats.map((id) => ({ dedupeKey: { startsWith: `turn.run:${id}:` } })) },
      })
    }
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
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.task.deleteMany({ where: owned })
    await db.project.deleteMany({ where: owned })
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
      caller.artifact.create({
        kind: 'diagram',
        title: 'Схема',
        projectId: null,
        templateId: null,
      }),
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

  async function quoteDocument() {
    const user = await person()
    const caller = callerOf(user)
    const { id: artifactId } = await caller.artifact.create({
      kind: 'document',
      title: 'Заметки о доставке',
      projectId: null,
      templateId: null,
    })
    const write = (ops: unknown[]) =>
      caller.artifact.write({ batch: { artifactId, opId: randomUUID(), ops } })
    const created = await write([
      {
        op: 'insert',
        block: 'delivery',
        after: null,
        kind: 'section',
        content: 'Печём **хлеб** &amp; булочки.\n\nДоставка утром.',
        props: { heading: 'Доставка' },
      },
    ])
    const anchor = {
      kind: 'quote' as const,
      block: 'delivery',
      rev: created.blocks[0]!.rev,
      quote: 'хлеб & булочки.',
    }
    return { user, caller, artifactId, anchor, write }
  }

  it('anchors private notes to checked words, independently of document revisions', async () => {
    const { caller, artifactId, anchor, write } = await quoteDocument()
    const body = 'Уточнить у пекаря'
    const add = (quote: string, rev = anchor.rev) =>
      caller.artifact.addComment({ artifactId, anchor: { ...anchor, quote, rev }, body })
    await expect(add('хлеб** &amp; булочки.')).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(add(anchor.quote, anchor.rev + 1)).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.artifact.addComment({ artifactId, anchor, body: ' '.repeat(20) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.artifact.addComment({ artifactId, anchor, body: 'А'.repeat(2001) }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(
      caller.artifact.addComment({ artifactId, anchor, body: 'Заметка\0' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(add(`${anchor.quote}\0`)).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    const { id } = await add(' хлеб   & булочки. ')
    const read = () => caller.artifact.comments({ artifactId })
    expect(await read()).toEqual([{ id, anchor, body, resolved: false, moved: false, replies: [] }])

    const other = callerOf(await person('Борис'))
    const set = { artifactId, commentId: id, resolved: true }
    await expect(other.artifact.comments({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(other.artifact.addComment({ artifactId, anchor, body })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(other.artifact.resolveComment(set)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    const sameOwnerOther = await caller.artifact.create({
      kind: 'document',
      title: 'Другой документ',
      projectId: null,
      templateId: null,
    })
    await expect(
      caller.artifact.resolveComment({ ...set, artifactId: sameOwnerOther.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    await caller.artifact.resolveComment(set)
    const stored = await db.artifactComment.findUniqueOrThrow({ where: { id } })
    await caller.artifact.resolveComment(set)
    expect((await db.artifactComment.findUniqueOrThrow({ where: { id } })).resolvedAt).toEqual(
      stored.resolvedAt,
    )
    expect(await read()).toMatchObject([{ resolved: true, moved: false }])
    await caller.artifact.resolveComment({ ...set, resolved: false })

    const change = (rev: number, content: string) =>
      write([
        { op: 'replace', block: anchor.block, ifRev: rev, content, props: { heading: 'Доставка' } },
      ])
    const edited = await change(anchor.rev, 'Ещё печём хлеб & булочки.')
    expect(await read()).toMatchObject([{ resolved: false, moved: false }])
    const repeated = await change(edited.blocks[0]!.rev, 'хлеб & булочки.\n\nхлеб & булочки.')
    expect(await read()).toMatchObject([{ moved: true }])
    await expect(add(anchor.quote, repeated.blocks[0]!.rev)).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    await write([{ op: 'delete', block: anchor.block, ifRev: repeated.blocks[0]!.rev }])
    expect(await read()).toMatchObject([{ id, moved: true }])

    await db.artifact.update({
      where: { id: artifactId },
      data: { takenDownAt: new Date(), takenDownBy: 'operator' },
    })
    await expect(read()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(caller.artifact.resolveComment(set)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await db.artifact.update({
      where: { id: artifactId },
      data: { takenDownAt: null, takenDownBy: null },
    })
    await caller.artifact.trash({ artifactId })
    await expect(read()).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(caller.artifact.resolveComment(set)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await caller.artifact.restore({ artifactId })
    expect(await read()).toMatchObject([{ id, moved: true, resolved: false }])
    await db.artifact.delete({ where: { id: artifactId } })
    expect(await db.artifactComment.count({ where: { artifactId } })).toBe(0)
  })

  it('lists a private reply once and replays it even after the note is closed (88.18б)', async () => {
    const { caller, artifactId, anchor } = await quoteDocument()
    const body = 'Уточнить время доставки'
    const { id: threadId } = await caller.artifact.addComment({ artifactId, anchor, body })
    const reply = { artifactId, threadId, requestId: randomUUID(), body: 'Доставим к девяти' }
    const saved = await caller.artifact.addCommentReply(reply)
    expect(saved.id).not.toBe(threadId)
    await expect(caller.artifact.addCommentReply(reply)).resolves.toEqual(saved)
    await expect(
      caller.artifact.addCommentReply({ ...reply, body: `  ${reply.body}\n` }),
    ).resolves.toEqual(saved)

    await caller.artifact.resolveComment({ artifactId, commentId: threadId, resolved: true })
    await expect(caller.artifact.addCommentReply(reply)).resolves.toEqual(saved)
    await expect(
      caller.artifact.addCommentReply({ ...reply, body: 'Доставим к десяти' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'ARTIFACT_OP_REUSED' } })
    await expect(
      caller.artifact.addCommentReply({ ...reply, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'ARTIFACT_COMMENT_UNAVAILABLE' } })
    expect(await caller.artifact.comments({ artifactId })).toEqual([
      {
        id: threadId,
        anchor,
        body,
        resolved: true,
        moved: false,
        replies: [
          { id: saved.id, body: reply.body, createdAt: expect.any(String), byAgent: false },
        ],
      },
    ])
    await expect(
      caller.artifact.resolveComment({ artifactId, commentId: saved.id, resolved: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', cause: { code: 'ARTIFACT_NOT_FOUND' } })
    await caller.artifact.resolveComment({ artifactId, commentId: threadId, resolved: false })
    const next = { ...reply, requestId: randomUUID(), body: 'В субботу позже' }
    const [first, repeated] = await Promise.all([
      caller.artifact.addCommentReply(next),
      caller.artifact.addCommentReply(next),
    ])
    expect(repeated).toEqual(first)
    expect(await caller.artifact.comments({ artifactId })).toMatchObject([
      { id: threadId, resolved: false, replies: [{ id: saved.id }, { id: first.id }] },
    ])
  })

  it('only accepts the owner’s open root and checks access before replaying a reply (88.18б)', async () => {
    const { caller, artifactId, anchor } = await quoteDocument()
    const otherUser = await person('Борис')
    const other = callerOf(otherUser)
    const { id: threadId } = await caller.artifact.addComment({
      artifactId,
      anchor,
      body: 'Согласовать время',
    })
    const reply = { artifactId, threadId, requestId: randomUUID(), body: 'После девяти' }
    const { id: replyId } = await caller.artifact.addCommentReply(reply)
    const { id: foreignRootId } = await db.artifactComment.create({
      data: {
        artifactId,
        blockKey: anchor.block,
        anchor,
        authorUserId: otherUser.id,
        body: 'Чужая заметка',
      },
      select: { id: true },
    })

    for (const unavailable of [randomUUID(), replyId, foreignRootId]) {
      await expect(
        caller.artifact.addCommentReply({ ...reply, threadId: unavailable }),
      ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'ARTIFACT_COMMENT_UNAVAILABLE' } })
    }
    const accessLost = { code: 'NOT_FOUND', cause: { code: 'ARTIFACT_NOT_FOUND' } }
    await expect(other.artifact.addCommentReply(reply)).rejects.toMatchObject(accessLost)
    await expect(other.artifact.comments({ artifactId })).rejects.toMatchObject(accessLost)

    await caller.artifact.trash({ artifactId })
    await expect(caller.artifact.addCommentReply(reply)).rejects.toMatchObject(accessLost)
    await expect(caller.artifact.comments({ artifactId })).rejects.toMatchObject(accessLost)
    await caller.artifact.restore({ artifactId })
    expect(await caller.artifact.comments({ artifactId })).toMatchObject([
      { id: threadId, replies: [{ id: replyId, body: reply.body }] },
    ])
  })

  async function commentDestination(
    data: Prisma.TaskUncheckedCreateInput,
    waitingFor: 'agent' | 'ceiling' | null = 'agent',
  ) {
    const { id: taskId } = await db.task.create({
      data: { status: 'awaiting_user', turnNo: 1, ...data },
      select: { id: true },
    })
    const questionId =
      waitingFor === null
        ? null
        : await db.$transaction((tx) =>
            insertFeedEvent(tx, {
              taskId,
              row: {
                type: 'feed.question',
                payload:
                  waitingFor === 'ceiling'
                    ? {
                        v: 1,
                        kind: 'ceiling',
                        turn: 1,
                        reason: 'credits',
                        spent: 5,
                        held: 5,
                        left: 0,
                      }
                    : {
                        v: 1,
                        kind: 'agent',
                        turn: 1,
                        intro: 'Нужно уточнить.',
                        questions: [{ text: 'Что уточнить о доставке?', options: [] }],
                      },
              },
            }),
          )
    return { taskId, questionId }
  }

  it('offers only the owner’s chats that can take notes in the same workspace (88.18в)', async () => {
    const { user, caller, artifactId } = await quoteDocument()
    const { workspaceId } = await db.artifact.findUniqueOrThrow({ where: { id: artifactId } })
    const guest = await quoteDocument()
    const separate = await db.artifact.findUniqueOrThrow({ where: { id: guest.artifactId } })
    // Both out-of-scope chats would be visible to the sender in the ordinary chat list.
    await db.member.createMany({
      data: [
        { workspaceId, userId: guest.user.id },
        { workspaceId: separate.workspaceId, userId: user.id },
      ],
    })
    const own = { workspaceId, createdById: user.id }
    const question = await commentDestination({
      ...own,
      title: 'Уточнение агента',
      updatedAt: new Date('2026-11-19T10:00:00Z'),
    })
    const ceiling = await commentDestination(
      {
        ...own,
        status: 'awaiting_approval',
        updatedAt: new Date('2026-11-20T10:00:00Z'),
      },
      'ceiling',
    )
    await commentDestination({ ...own, createdById: guest.user.id, title: 'Другой автор' })
    await commentDestination({
      ...own,
      workspaceId: separate.workspaceId,
      title: 'Другое пространство',
    })
    await commentDestination({ ...own, billable: false, title: 'Без оплаты' })
    await commentDestination({ ...own, status: 'running', title: 'Агент работает' })
    await commentDestination({ ...own, deletedAt: new Date(), title: 'Удалённый' })
    await commentDestination({ ...own, status: 'awaiting_approval', title: 'Не вопрос о кредитах' })
    // More than one page of newer candidates must not hide the older eligible chats.
    await db.task.createMany({
      data: Array.from({ length: 41 }, () => ({
        ...own,
        status: 'awaiting_user',
        title: 'Нет открытого события',
        updatedAt: new Date('2026-11-21T10:00:00Z'),
      })),
    })
    const cancelling = await commentDestination({
      ...own,
      title: 'Браузер останавливается',
      needsBrowser: true,
    })
    await insertFeedEvent(db, {
      taskId: cancelling.taskId,
      row: {
        type: 'feed.request',
        payload: {
          v: 1,
          kind: 'command',
          command: 'cancel',
          authorId: user.id,
          requestId: randomUUID(),
        },
      },
    })

    expect(await caller.artifact.commentDispatchChats({ artifactId })).toEqual([
      { taskId: ceiling.taskId, title: null },
      { taskId: question.taskId, title: 'Уточнение агента' },
    ])
    await expect(guest.caller.artifact.commentDispatchChats({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('sends notes through the cabinet once and keeps their text out of the chat feed (88.18в)', async () => {
    const { user, caller, artifactId, anchor } = await quoteDocument()
    const { workspaceId } = await db.artifact.findUniqueOrThrow({ where: { id: artifactId } })
    const { taskId, questionId } = await commentDestination({
      workspaceId,
      createdById: user.id,
      modelClass: 'standard',
    })
    dispatchChatIds.push(taskId)
    const now = new Date()
    await placeReserve(db, {
      workspaceId,
      taskId,
      attempt: 1,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    const body = 'Уточнить время у пекаря.'
    const reply = 'В субботу можно после девяти.'
    const { id: threadId } = await caller.artifact.addComment({ artifactId, anchor, body })
    await caller.artifact.addCommentReply({
      artifactId,
      threadId,
      requestId: randomUUID(),
      body: reply,
    })
    const input = {
      artifactId,
      target: { kind: 'existing' as const, taskId },
      requestId: randomUUID(),
      threadIds: [threadId],
      text: '  ',
    }

    const sent = await caller.artifact.dispatchComments(input)
    expect(sent).toEqual({
      taskId,
      requestEventId: expect.stringMatching(/^\d+$/u),
      repeated: false,
    })
    await expect(caller.artifact.dispatchComments({ ...input, text: '' })).resolves.toEqual({
      ...sent,
      repeated: true,
    })
    await expect(
      caller.artifact.dispatchComments({ ...input, text: 'Новая просьба.' }),
    ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'ARTIFACT_OP_REUSED' } })
    await expect(
      caller.artifact.dispatchComments({ ...input, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'TASK_BUSY' } })
    expect(await caller.artifact.commentDispatchChats({ artifactId })).toEqual([])

    const feed = await caller.task.feed({ taskId })
    expect(feed.task.status).toBe('queued')
    expect(feed.events.filter((event) => event.type === 'feed.request')).toMatchObject([
      {
        id: sent.requestEventId,
        kind: 'answer',
        answersEventId: String(questionId),
        text: 'Заметки к артефакту',
      },
    ])
    expect(JSON.stringify(feed.events)).not.toContain(body)
    expect(JSON.stringify(feed.events)).not.toContain(reply)
    expect(await caller.artifact.ofChat({ taskId })).toMatchObject([
      { id: artifactId, group: 'mentioned' },
    ])
    expect(
      await db.outboxEvent.findMany({
        where: { dedupeKey: { startsWith: `turn.run:${taskId}:` } },
        select: { type: true, payload: true },
      }),
    ).toMatchObject([
      { type: 'turn.run', payload: { taskId, requestEventId: sent.requestEventId } },
    ])
  })

  /** A note with the owner's reply, sent by «Отправить агенту» to a chat of the owner (88.18в). */
  async function sentNote() {
    const { user, caller, artifactId, anchor } = await quoteDocument()
    const { workspaceId } = await db.artifact.findUniqueOrThrow({ where: { id: artifactId } })
    const { taskId } = await commentDestination({
      workspaceId,
      createdById: user.id,
      modelClass: 'standard',
    })
    dispatchChatIds.push(taskId)
    const now = new Date()
    await placeReserve(db, {
      workspaceId,
      taskId,
      attempt: 1,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    const { id: threadId } = await caller.artifact.addComment({
      artifactId,
      anchor,
      body: 'Добавить цены на июль.',
    })
    await caller.artifact.addCommentReply({
      artifactId,
      threadId,
      requestId: randomUUID(),
      body: 'И на август.',
    })
    await caller.artifact.dispatchComments({
      artifactId,
      target: { kind: 'existing', taskId },
      requestId: randomUUID(),
      threadIds: [threadId],
      text: '',
    })
    const reply = (
      body: string,
      extra: { requestId?: string; resolve?: boolean; now?: Date } = {},
    ) =>
      addAgentCommentReply(db, {
        taskId,
        turnNo: 2,
        threadId,
        requestId: extra.requestId ?? randomUUID(),
        body,
        resolve: extra.resolve ?? false,
        now: extra.now ?? new Date(),
      })
    return { user, caller, artifactId, workspaceId, taskId, threadId, reply }
  }

  it('lets the agent read the notes sent to its chat and reply after the check (88.18г)', async () => {
    const { user, caller, artifactId, workspaceId, taskId, threadId, reply } = await sentNote()
    expect(await readChatArtifactComments(db, { taskId })).toEqual([
      {
        threadId,
        artifactId,
        anchor: {
          kind: 'quote',
          block: 'delivery',
          rev: expect.any(Number),
          quote: 'хлеб & булочки.',
        },
        body: 'Добавить цены на июль.',
        ownerReplies: ['И на август.'],
        resolved: false,
        yourReplies: [],
      },
    ])
    // Another chat of the same owner was never sent the note: it neither reads nor replies.
    const { taskId: other } = await commentDestination({
      workspaceId,
      createdById: user.id,
      modelClass: 'standard',
    })
    expect(await readChatArtifactComments(db, { taskId: other })).toEqual([])
    await expect(
      addAgentCommentReply(db, {
        taskId: other,
        turnNo: 1,
        threadId,
        requestId: randomUUID(),
        body: 'Готово.',
        resolve: false,
        now: new Date(),
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_COMMENT_UNAVAILABLE' })

    const requestId = randomUUID()
    const first = await reply('Добавил цены на июль и август.', { requestId, resolve: true })
    expect(first).toEqual({ id: expect.any(String), artifactId, repeated: false })
    await expect(
      reply('Добавил цены на июль и август.', { requestId, resolve: true }),
    ).resolves.toEqual({ ...first, repeated: true })
    await expect(reply('Другой текст.', { requestId, resolve: true })).rejects.toMatchObject({
      code: 'ARTIFACT_OP_REUSED',
    })
    // Until the check, only the writing chat sees the reply; the note stays open.
    const [waiting] = await caller.artifact.comments({ artifactId })
    expect(waiting).toMatchObject({ resolved: false, replies: [{ body: 'И на август.' }] })
    expect(waiting!.replies).toHaveLength(1)
    expect((await readChatArtifactComments(db, { taskId }))[0]!.yourReplies).toEqual([
      { id: first.id, body: 'Добавил цены на июль и август.', checking: true },
    ])

    await expect(
      settleAgentCommentReplies(db, {
        taskId,
        now: new Date(),
        verdicts: [{ id: first.id, refused: false }],
      }),
    ).resolves.toEqual({ checked: 1, refused: 0 })
    const [shown] = await caller.artifact.comments({ artifactId })
    expect(shown).toMatchObject({
      resolved: true,
      replies: [
        { body: 'И на август.', byAgent: false },
        { body: 'Добавил цены на июль и август.', byAgent: true },
      ],
    })
    await expect(reply('Ещё одно.')).rejects.toMatchObject({
      code: 'ARTIFACT_COMMENT_UNAVAILABLE',
    })
  })

  it('deletes a refused reply, drops those of a failed turn and stale ones (88.18г)', async () => {
    const { caller, artifactId, taskId, reply } = await sentNote()
    const refused = await reply('Ответ, который не прошёл.', { resolve: true })
    await expect(
      settleAgentCommentReplies(db, {
        taskId,
        now: new Date(),
        verdicts: [{ id: refused.id, refused: true }],
      }),
    ).resolves.toEqual({ checked: 0, refused: 1 })
    const [note] = await caller.artifact.comments({ artifactId })
    expect(note).toMatchObject({ resolved: false })
    expect(note!.replies).toHaveLength(1)

    await reply('Ход упал.')
    await expect(dropAgentCommentReplies(db, taskId)).resolves.toBe(1)

    const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
    const stale = await reply('Завис.', { now: hourAgo })
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000)
    // A chat this core still runs keeps its reply, as the collector of blocks does.
    await dropStaleAgentCommentReplies(db, tenMinutesAgo, (id) => id === taskId)
    expect(await db.artifactCommentReply.findUnique({ where: { id: stale.id } })).not.toBeNull()
    await expect(
      dropStaleAgentCommentReplies(db, new Date(Date.now() - 10 * 60 * 1000)),
    ).resolves.toBeGreaterThanOrEqual(1)
    expect(await db.artifactCommentReply.findUnique({ where: { id: stale.id } })).toBeNull()
    expect((await readChatArtifactComments(db, { taskId }))[0]!.yourReplies).toEqual([])
  })

  it('anchors a private note to a cell of a table and sends it with the cell (88.18д)', async () => {
    const user = await person()
    const caller = callerOf(user)
    const { id: artifactId } = await caller.artifact.create({
      kind: 'table',
      title: 'Прайс',
      projectId: null,
      templateId: null,
    })
    const write = (ops: unknown[]) =>
      caller.artifact.write({ batch: { artifactId, opId: randomUUID(), ops } })
    const columns = [
      { key: 'name', name: 'Товар', type: 'text' },
      { key: 'note', name: 'Примечание', type: 'text' },
    ]
    const created = await write([
      {
        op: 'insert',
        block: 'cols',
        after: null,
        kind: 'columns',
        content: JSON.stringify(columns),
      },
      {
        op: 'insert',
        block: 'r1',
        after: 'cols',
        kind: 'row',
        content: JSON.stringify({ name: 'Хлеб', note: 'утром' }),
      },
    ])
    const row = created.blocks.find((block) => block.key === 'r1')!
    const cell = { kind: 'cell' as const, block: 'r1', column: 'name', rev: row.rev }
    // A table takes notes to its cells, never to a quote; a stale row or an unknown column is refused.
    await expect(
      caller.artifact.addComment({
        artifactId,
        anchor: { kind: 'quote', block: 'r1', rev: row.rev, quote: 'Хлеб' },
        body: 'Проверить',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      caller.artifact.addComment({ artifactId, anchor: { ...cell, rev: row.rev + 1 }, body: 'А' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.artifact.addComment({ artifactId, anchor: { ...cell, column: 'price' }, body: 'А' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const { id: threadId } = await caller.artifact.addComment({
      artifactId,
      anchor: cell,
      body: 'Добавить ржаной',
    })
    const stored = { ...cell, columnName: 'Товар', text: 'Хлеб' }
    expect(await caller.artifact.comments({ artifactId })).toMatchObject([
      { id: threadId, anchor: stored, moved: false, resolved: false },
    ])
    // A new value keeps the place; a deleted row moves it.
    await write([{ op: 'cells', block: 'r1', cells: { name: 'Батон' } }])
    expect((await caller.artifact.comments({ artifactId }))[0]).toMatchObject({ moved: false })
    const r1 = (await caller.artifact.read({ artifactId })).blocks.find((b) => b.key === 'r1')!
    await write([{ op: 'delete', block: 'r1', ifRev: r1.rev }])
    expect((await caller.artifact.comments({ artifactId }))[0]).toMatchObject({
      anchor: stored,
      moved: true,
    })

    const { workspaceId } = await db.artifact.findUniqueOrThrow({ where: { id: artifactId } })
    const { taskId } = await commentDestination({
      workspaceId,
      createdById: user.id,
      modelClass: 'standard',
    })
    dispatchChatIds.push(taskId)
    const now = new Date()
    await placeReserve(db, {
      workspaceId,
      taskId,
      attempt: 1,
      now,
      expiresAt: new Date(now.getTime() + 60_000),
    })
    await caller.artifact.dispatchComments({
      artifactId,
      target: { kind: 'existing', taskId },
      requestId: randomUUID(),
      threadIds: [threadId],
      text: '',
    })
    expect(await readChatArtifactComments(db, { taskId })).toMatchObject([
      { threadId, artifactId, anchor: stored, body: 'Добавить ржаной' },
    ])
  })

  it('anchors a private note to an element of a mockup by the id the server stamps (88.18е)', async () => {
    const user = await person()
    const caller = callerOf(user)
    const { id: artifactId } = await caller.artifact.create({
      kind: 'mockup',
      title: 'Лендинг',
      projectId: null,
      templateId: null,
    })
    const write = (ops: unknown[]) =>
      caller.artifact.write({ batch: { artifactId, opId: randomUUID(), ops } })
    const created = await write([
      {
        op: 'insert',
        block: 'hero',
        after: null,
        kind: 'html',
        content: '<section><h2>Цены</h2><p>Хлеб <b>120 ₽</b></p></section>',
      },
    ])
    const hero = created.blocks.find((block) => block.key === 'hero')!
    // section — hero.1, h2 — hero.2, p — hero.3.
    const element = { kind: 'element' as const, block: 'hero', element: 'hero.2', rev: hero.rev }
    await expect(
      caller.artifact.addComment({
        artifactId,
        anchor: { kind: 'quote', block: 'hero', rev: hero.rev, quote: 'Цены' },
        body: 'А',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      caller.artifact.addComment({
        artifactId,
        anchor: { ...element, element: 'hero.9' },
        body: 'А',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await expect(
      caller.artifact.addComment({
        artifactId,
        anchor: { ...element, rev: hero.rev + 1 },
        body: 'А',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' })

    const { id } = await caller.artifact.addComment({
      artifactId,
      anchor: element,
      body: 'Сделать заголовок крупнее',
    })
    expect(await caller.artifact.comments({ artifactId })).toMatchObject([
      { id, anchor: { ...element, tag: 'h2', text: 'Цены' }, moved: false },
    ])
    // The heading is gone: the id names another element no more, the place moved.
    await write([{ op: 'replace', block: 'hero', ifRev: hero.rev, content: '<p>Хлеб</p>' }])
    expect((await caller.artifact.comments({ artifactId }))[0]).toMatchObject({ moved: true })
  })

  it('moves an artifact into a live project of its owner and back to personal (88.19)', async () => {
    const user = await person()
    const caller = callerOf(user)
    // The first artifact makes the personal workspace the project goes in.
    const { id: artifactId } = await caller.artifact.create({
      kind: 'document',
      title: 'План',
      projectId: null,
      templateId: null,
    })
    const project = await projectOf(user)
    await expect(caller.artifact.move({ artifactId, projectId: project.id })).resolves.toEqual({
      moved: true,
    })
    expect((await caller.artifact.read({ artifactId })).project).toEqual({
      id: project.id,
      name: 'Пекарня',
    })
    await expect(caller.artifact.move({ artifactId, projectId: project.id })).resolves.toEqual({
      moved: false,
    })
    await expect(caller.artifact.move({ artifactId, projectId: null })).resolves.toEqual({
      moved: true,
    })
    expect((await caller.artifact.read({ artifactId })).project).toBeNull()

    // Not a project of the owner, or one in «Архив»: refused; another person never moves it.
    const other = await person('Борис')
    await callerOf(other).artifact.create({
      kind: 'document',
      title: 'Своё',
      projectId: null,
      templateId: null,
    })
    const foreign = await projectOf(other)
    await expect(caller.artifact.move({ artifactId, projectId: foreign.id })).rejects.toMatchObject(
      { cause: { code: 'ARTIFACT_PROJECT_UNAVAILABLE' } },
    )
    await caller.project.archive({ projectId: project.id, archived: true })
    await expect(caller.artifact.move({ artifactId, projectId: project.id })).rejects.toMatchObject(
      { cause: { code: 'ARTIFACT_PROJECT_UNAVAILABLE' } },
    )
    await expect(
      callerOf(other).artifact.move({ artifactId, projectId: foreign.id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('takes the artifacts of a project into the trash with it and back, only its own (88.19)', async () => {
    const user = await person()
    const caller = callerOf(user)
    // A personal artifact: the trash of a project never touches it.
    const { id: personal } = await caller.artifact.create({
      kind: 'document',
      title: 'Личный',
      projectId: null,
      templateId: null,
    })
    const project = await projectOf(user)
    const create = (title: string) =>
      caller.artifact.create({ kind: 'document', title, projectId: project.id, templateId: null })
    const { id: kept } = await create('Живой')
    const { id: earlier } = await create('Удалён раньше')
    await caller.artifact.trash({ artifactId: earlier })

    await caller.project.remove({ projectId: project.id })
    const trashed = await db.artifact.findUniqueOrThrow({ where: { id: kept } })
    expect(trashed).toMatchObject({ deletedBy: 'project' })
    expect(trashed.deletedAt).not.toBeNull()
    expect((await db.artifact.findUniqueOrThrow({ where: { id: earlier } })).deletedBy).toBe(
      'client',
    )
    expect((await db.artifact.findUniqueOrThrow({ where: { id: personal } })).deletedAt).toBeNull()
    // Alone it does not come back while its project is in the trash.
    await expect(caller.artifact.restore({ artifactId: kept })).rejects.toMatchObject({
      cause: { code: 'ARTIFACT_PROJECT_IN_TRASH' },
    })

    await caller.project.restore({ projectId: project.id })
    expect(await db.artifact.findUniqueOrThrow({ where: { id: kept } })).toMatchObject({
      deletedAt: null,
      deletedBy: null,
      purgeAfter: null,
    })
    expect((await db.artifact.findUniqueOrThrow({ where: { id: earlier } })).deletedBy).toBe(
      'client',
    )
    expect(
      (await caller.artifact.list({ filter: 'all', projectId: project.id })).map((row) => row.id),
    ).toEqual([kept])
  })

  it('closes an artifact by the support’s decision and opens it again (88.23, Ар57)', async () => {
    const user = await person()
    const caller = callerOf(user)
    const { id: artifactId } = await caller.artifact.create({
      kind: 'document',
      title: 'По жалобе',
      projectId: null,
      templateId: null,
    })
    const decide = (decision: 'take_down' | 'return') =>
      operatorArtifactDecision(db, {
        artifactId,
        decision,
        reason: 'Жалоба №7',
        operator: 'support',
      })
    await expect(decide('take_down')).resolves.toMatchObject({ kind: 'done', artifactId })
    await expect(decide('take_down')).resolves.toMatchObject({ kind: 'repeated' })
    // Its owner no longer opens it, nor finds it in the gallery.
    await expect(caller.artifact.read({ artifactId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await caller.artifact.list({ filter: 'all' })).map((row) => row.id)).not.toContain(
      artifactId,
    )
    await expect(decide('return')).resolves.toMatchObject({ kind: 'done' })
    await expect(decide('return')).resolves.toMatchObject({ kind: 'repeated' })
    expect((await caller.artifact.read({ artifactId })).id).toBe(artifactId)
    expect(
      await db.auditLog.findMany({
        where: { targetId: artifactId },
        orderBy: { createdAt: 'asc' },
        select: { action: true, actorType: true, meta: true },
      }),
    ).toEqual([
      { action: 'artifacts.take_down', actorType: 'operator', meta: { reason: 'Жалоба №7' } },
      { action: 'artifacts.put_back', actorType: 'operator', meta: { reason: 'Жалоба №7' } },
    ])
    await expect(
      operatorArtifactDecision(db, {
        artifactId: '019f1a21-1800-7f00-8abc-0000000000ff',
        decision: 'take_down',
        reason: 'Нет такого',
        operator: 'support',
      }),
    ).resolves.toEqual({ kind: 'not_found' })
  })

  it('reads notes and their access decision at the same snapshot during a takedown', async () => {
    const { user, caller, artifactId, anchor } = await quoteDocument()
    const { id } = await caller.artifact.addComment({ artifactId, anchor, body: 'Старая заметка' })
    const duringTakedown = db.$extends({
      query: {
        artifactComment: {
          async findMany({ args, query }) {
            // In this fixture, the access decision has already been read. Change both facts
            // on a different connection, before the reader asks for the notes.
            await db.$transaction([
              db.artifact.update({
                where: { id: artifactId },
                data: { takenDownAt: new Date(), takenDownBy: 'operator' },
              }),
              db.artifactComment.update({ where: { id }, data: { body: 'Новая заметка' } }),
            ])
            return query(args)
          },
        },
      },
    })
    // The extension wraps one query; it does not change any model or the transaction API.
    const before = await readArtifactComments(duringTakedown as unknown as PrismaClient, {
      artifactId,
      userId: user.id,
    })
    expect(before.comments).toMatchObject([{ id, body: 'Старая заметка' }])
    await expect(caller.artifact.comments({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('keeps a note without its deleted author and never shows it in the private list', async () => {
    const { caller, artifactId, anchor } = await quoteDocument()
    const author = await person('Борис')
    const body = 'Уточнить детали'
    const { id } = await db.artifactComment.create({
      data: { artifactId, blockKey: anchor.block, anchor, authorUserId: author.id, body },
      select: { id: true },
    })
    await db.user.delete({ where: { id: author.id } })
    expect(await db.artifactComment.findUniqueOrThrow({ where: { id } })).toMatchObject({
      authorUserId: null,
      anchor,
      body,
    })
    expect(await caller.artifact.comments({ artifactId })).toEqual([])
    await expect(
      caller.artifact.resolveComment({ artifactId, commentId: id, resolved: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await db.artifact.delete({ where: { id: artifactId } })
    expect(await db.artifactComment.findUnique({ where: { id } })).toBeNull()
  })

  it('admits only one concurrent note when just one slot remains', async () => {
    const { caller, artifactId, anchor } = await quoteDocument()
    const input = { artifactId, anchor, body: 'Решить с доставкой' }
    const { id } = await caller.artifact.addComment(input)
    const { authorUserId, blockKey } = await db.artifactComment.findUniqueOrThrow({ where: { id } })
    await db.artifactComment.createMany({
      data: Array.from({ length: artifactLimits.comments - 2 }, () => ({
        ...input,
        authorUserId,
        blockKey,
      })),
    })
    const outcomes = await Promise.allSettled([
      caller.artifact.addComment({ ...input, body: 'Первый' }),
      caller.artifact.addComment({ ...input, body: 'Второй' }),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT', cause: { code: 'ARTIFACT_LIMIT' } },
    })
    expect(await db.artifactComment.count({ where: { artifactId } })).toBe(artifactLimits.comments)
  })

  it('shares the last comment slot between roots and replies and still replays at the limit (88.18б)', async () => {
    const { user, caller, artifactId, anchor } = await quoteDocument()
    const input = { artifactId, anchor, body: 'Согласовать время' }
    const { id: threadId } = await caller.artifact.addComment(input)
    const reply = { artifactId, threadId, requestId: randomUUID(), body: 'После девяти' }
    const saved = await caller.artifact.addCommentReply(reply)
    await db.artifactComment.createMany({
      data: Array.from({ length: artifactLimits.comments - 3 }, () => ({
        ...input,
        authorUserId: user.id,
        blockKey: anchor.block,
      })),
    })
    const lastReply = { ...reply, requestId: randomUUID(), body: 'До полудня' }
    const outcomes = await Promise.allSettled([
      caller.artifact.addComment({ ...input, body: 'Новая заметка' }),
      caller.artifact.addCommentReply(lastReply),
    ])
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.find((outcome) => outcome.status === 'rejected')).toMatchObject({
      reason: { code: 'CONFLICT', cause: { code: 'ARTIFACT_LIMIT' } },
    })
    await expect(caller.artifact.addCommentReply(reply)).resolves.toEqual(saved)
    await expect(
      caller.artifact.addCommentReply({ ...lastReply, requestId: randomUUID() }),
    ).rejects.toMatchObject({ code: 'CONFLICT', cause: { code: 'ARTIFACT_LIMIT' } })
  })

  it('keeps replies out of the previous reader and deletes them with their root (88.18б)', async () => {
    const { user, caller, artifactId, anchor } = await quoteDocument()
    const { id: threadId } = await caller.artifact.addComment({
      artifactId,
      anchor,
      body: 'Согласовать время',
    })
    const { id: replyId } = await caller.artifact.addCommentReply({
      artifactId,
      threadId,
      requestId: randomUUID(),
      body: 'После девяти',
    })
    expect(await db.artifactCommentReply.findUnique({ where: { id: replyId } })).toMatchObject({
      threadId,
    })
    // Keep the previous version's read shape to verify that the migration is additive.
    expect(
      await db.artifactComment.findMany({
        where: { artifactId, authorUserId: user.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, blockKey: true, anchor: true, body: true, resolvedAt: true },
      }),
    ).toEqual([
      { id: threadId, blockKey: anchor.block, anchor, body: 'Согласовать время', resolvedAt: null },
    ])
    // There is no delete-note procedure; deleting the root exercises the database cascade.
    await db.artifactComment.delete({ where: { id: threadId } })
    expect(await db.artifactCommentReply.findUnique({ where: { id: replyId } })).toBeNull()
    expect(await caller.artifact.comments({ artifactId })).toEqual([])
  })

  it('keeps existing notes but rejects new anchors while an agent revision awaits review', async () => {
    const { user, caller, artifactId, anchor } = await quoteDocument()
    const { id: workspaceId } = await db.workspace.findFirstOrThrow({
      where: { createdById: user.id },
      select: { id: true },
    })
    const saved = await caller.artifact.addComment({ artifactId, anchor, body: 'Первая заметка' })
    await caller.artifact.release({ artifactId, block: anchor.block })
    const { id: taskId } = await db.task.create({
      data: { workspaceId, createdById: user.id, title: 'Уточнить доставку' },
      select: { id: true },
    })
    const changed = await applyArtifactOps(db, {
      batch: {
        artifactId,
        opId: randomUUID(),
        ops: [
          {
            op: 'edit',
            block: anchor.block,
            find: 'Доставка утром.',
            replace: 'Доставка вечером.',
          },
        ],
      },
      actor: { kind: 'agent', taskId, turnNo: 1 },
    })
    const rev = changed.blocks[0]!.rev
    const input = { artifactId, anchor: { ...anchor, rev }, body: 'Вторая заметка' }
    const [block] = (await caller.artifact.read({ artifactId })).blocks
    expect(block).toMatchObject({ checking: true, rev, content: expect.stringContaining('утром') })
    await expect(caller.artifact.addComment(input)).rejects.toMatchObject({
      code: 'CONFLICT',
      cause: { code: 'ARTIFACT_STALE' },
    })
    expect(await caller.artifact.comments({ artifactId })).toMatchObject([
      { id: saved.id, moved: false },
    ])
    await settleArtifactWrites(db, {
      taskId,
      blocks: [{ artifactId, block: anchor.block, rev, refusal: null }],
      final: true,
    })
    await expect(caller.artifact.addComment(input)).resolves.toHaveProperty('id')
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

  it('keeps versions, returns one, and takes back the edits of one turn (88.11а)', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const { id } = await caller.artifact.create({
      kind: 'document',
      title: 'Цены',
      projectId: null,
      templateId: null,
    })
    const { workspaceId } = await db.artifact.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true },
    })
    const write = (ops: unknown[]) =>
      caller.artifact.write({ batch: { artifactId: id, opId: randomUUID(), ops } })
    await write([
      {
        op: 'insert',
        block: 'a',
        after: null,
        kind: 'section',
        content: 'Старая цена',
        props: { heading: 'Цена' },
      },
    ])
    const first = await caller.artifact.saveVersion({ artifactId: id, label: 'До праздников' })
    const rev = (await caller.artifact.read({ artifactId: id })).blocks[0]!.rev
    await write([
      { op: 'replace', block: 'a', ifRev: rev, content: 'Новая цена', props: { heading: 'Цена' } },
    ])
    // The person closed the editor; a turn of a chat edits the section and inserts another.
    await caller.artifact.release({ artifactId: id, block: 'a' })
    const task = await db.task.create({
      data: { workspaceId, createdById: anna.id, title: 'Цены' },
      select: { id: true },
    })
    const agent = { kind: 'agent' as const, taskId: task.id, turnNo: 1 }
    const before = (await caller.artifact.read({ artifactId: id })).blocks[0]!.rev
    const turn = await applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [
          {
            op: 'replace',
            block: 'a',
            ifRev: before,
            content: 'Цена агента',
            props: { heading: 'Цена' },
          },
          {
            op: 'insert',
            block: 'b',
            after: 'a',
            kind: 'section',
            content: 'Доставка',
            props: { heading: 'Доставка' },
          },
        ],
      },
      actor: agent,
    })
    await settleArtifactWrites(db, {
      taskId: task.id,
      blocks: turn.blocks.map((block) => ({
        artifactId: id,
        block: block.key,
        rev: block.rev,
        refusal: null,
      })),
      final: true,
    })
    expect(
      (await caller.artifact.read({ artifactId: id })).blocks.map((block) => block.content),
    ).toEqual(['Цена агента', 'Доставка'])
    expect(await caller.artifact.turnArtifacts({ taskId: task.id, turnNo: 1 })).toEqual([
      { id, title: 'Цены' },
    ])
    expect(await caller.artifact.undoTurn({ artifactId: id, taskId: task.id, turnNo: 1 })).toEqual({
      undone: 2,
      kept: 0,
    })
    expect(
      (await caller.artifact.read({ artifactId: id })).blocks.map((block) => block.content),
    ).toEqual(['Новая цена\n'])
    // The version is returned: a new version, what it overwrites named first.
    const preview = await caller.artifact.restorePreview({ artifactId: id, no: first.no })
    expect(preview.blocks).toBe(1)
    const restored = await caller.artifact.restoreVersion({ artifactId: id, no: first.no })
    expect(restored.no).toBeGreaterThan(first.no)
    expect(
      (await caller.artifact.read({ artifactId: id })).blocks.map((block) => block.content),
    ).toEqual(['Старая цена\n'])
    const versions = await caller.artifact.versions({ artifactId: id })
    expect(versions[0]).toMatchObject({ no: restored.no, current: true })
    expect(versions.find((each) => each.no === first.no)).toMatchObject({
      label: 'До праздников',
      named: true,
    })
    expect(
      (await caller.artifact.version({ artifactId: id, no: first.no })).blocks[0],
    ).toMatchObject({
      heading: 'Цена',
      content: 'Старая цена\n',
    })
    const changes = await caller.artifact.changes({ artifactId: id })
    expect(
      changes.some((change) => change.author.kind === 'agent' && change.author.chat === 'Цены'),
    ).toBe(true)
    // Another person sees no history.
    const boris = callerOf(await person('Борис'))
    await expect(boris.artifact.versions({ artifactId: id })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(
      boris.artifact.undoTurn({ artifactId: id, taskId: task.id, turnNo: 1 }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('publishes a document as a page — only its owner — and again as its next version (88.11б)', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const { id } = await caller.artifact.create({
      kind: 'document',
      title: 'Правила возврата',
      projectId: null,
      templateId: 'returns',
    })
    expect(await caller.pages.artifactPublication({ artifactId: id })).toBeNull()
    // No version yet: the current text becomes one, and that is what goes out.
    const first = await caller.pages.publishArtifact({ artifactId: id, versionNo: null })
    expect(first).toMatchObject({ version: 1, versionNo: 1 })
    expect(first.url).toMatch(/^http:\/\/[a-z0-9-]+\.pages\.localhost:3110\/$/)
    const page = await db.pageContent.findUniqueOrThrow({ where: { pageId: first.pageId } })
    expect(Buffer.from(page.bytes).toString('utf8')).toContain('Правила возврата')
    expect(await caller.pages.artifactPublication({ artifactId: id })).toMatchObject({
      pageId: first.pageId,
      versionNo: 1,
      current: true,
    })
    // An edit and a new version: «Обновить страницу» is the next version of the same page.
    const rev = (await caller.artifact.read({ artifactId: id })).blocks[0]!.rev
    await caller.artifact.write({
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [
          {
            op: 'replace',
            block: 's1',
            ifRev: rev,
            content: 'Вернуть можно за 14 дней.',
            props: { heading: 'Сроки' },
          },
        ],
      },
    })
    const saved = await caller.artifact.saveVersion({ artifactId: id, label: 'Новые сроки' })
    expect((await caller.pages.artifactPublication({ artifactId: id }))?.current).toBe(false)
    const second = await caller.pages.publishArtifact({ artifactId: id, versionNo: saved.no })
    expect(second).toMatchObject({ pageId: first.pageId, version: 2, versionNo: saved.no })
    // Another person publishes nothing of it.
    const boris = callerOf(await person('Борис'))
    await expect(
      boris.pages.publishArtifact({ artifactId: id, versionNo: null }),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('returns a version all at once or not at all: a block an agent writes holds it (Ар13)', async () => {
    const anna = await person()
    const caller = callerOf(anna)
    const { id } = await caller.artifact.create({
      kind: 'document',
      title: 'Меню',
      projectId: null,
      templateId: 'faq',
    })
    const first = await caller.artifact.saveVersion({ artifactId: id, label: 'Начало' })
    const blocks = (await caller.artifact.read({ artifactId: id })).blocks
    // The person changed two sections; then a turn writes the third, not checked yet.
    for (const block of blocks.slice(0, 2)) {
      await caller.artifact.write({
        batch: {
          artifactId: id,
          opId: randomUUID(),
          ops: [
            {
              op: 'replace',
              block: block.key,
              ifRev: block.rev,
              content: 'Новое',
              props: { heading: block.heading ?? 'Р' },
            },
          ],
        },
      })
      await caller.artifact.release({ artifactId: id, block: block.key })
    }
    const { workspaceId } = await db.artifact.findUniqueOrThrow({
      where: { id },
      select: { workspaceId: true },
    })
    const task = await db.task.create({
      data: { workspaceId, createdById: anna.id, title: 'Меню' },
      select: { id: true },
    })
    const third = blocks[2]!
    await caller.artifact.release({ artifactId: id, block: third.key })
    await applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [
          {
            op: 'replace',
            block: third.key,
            ifRev: third.rev,
            content: 'От агента',
            props: { heading: third.heading ?? 'Р' },
          },
        ],
      },
      actor: { kind: 'agent', taskId: task.id, turnNo: 1 },
    })
    const before = await caller.artifact.read({ artifactId: id })
    expect((await caller.artifact.restorePreview({ artifactId: id, no: first.no })).held).toBe(1)
    await expect(
      caller.artifact.restoreVersion({ artifactId: id, no: first.no }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    const after = await caller.artifact.read({ artifactId: id })
    expect(after.blocks.map((block) => [block.key, block.rev, block.content])).toEqual(
      before.blocks.map((block) => [block.key, block.rev, block.content]),
    )
    expect(after.version).toBe(before.version)
  })
})
