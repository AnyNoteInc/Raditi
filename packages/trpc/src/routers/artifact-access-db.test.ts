import { randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient, type User } from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import type { ChatContext } from '../services/chat/context.ts'

// Access of other users to an artifact on PostgreSQL (docs/plan/88-artifacts.md, Ар33–Ар36, §7.8;
// slice 88.16-1): the matrix «role × path» — the owner, a recipient who «Смотрит», one who
// «Правит», a stranger — and the life of a link: revoke, expiry, «Закрыть доступ всем», «Выйти».

const databaseUrl = process.env.DATABASE_URL

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

describe.skipIf(!databaseUrl)('PostgreSQL: access of other users to an artifact', () => {
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
    await db.artifact.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.member.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'artifact-open' } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function person(name: string): Promise<User> {
    const row = await db.user.create({
      data: { name, email: `${randomUUID()}@artifacts-access.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  function callerOf(user: User, appEnv: 'test' | 'production' = 'test') {
    const chat: ChatContext = {
      appEnv,
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
        token: `artifacts-access-${randomUUID()}`,
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

  /** An owner's document with one section, and three other people. */
  async function shared() {
    const owner = await person('Анна')
    const viewer = await person('Борис')
    const editor = await person('Вера')
    const stranger = await person('Глеб')
    const as = { owner: callerOf(owner), viewer: callerOf(viewer), editor: callerOf(editor) }
    const { id: artifactId } = await as.owner.artifact.create({
      kind: 'document',
      title: 'План',
      projectId: null,
      templateId: null,
    })
    await as.owner.artifact.write({
      batch: {
        artifactId,
        opId: randomUUID(),
        ops: [
          {
            op: 'insert',
            block: 's1',
            after: null,
            kind: 'section',
            content: 'Текст',
            props: { heading: 'Раздел' },
          },
        ],
      },
    })
    return { owner, viewer, editor, stranger, as, artifactId }
  }

  const insertOp = () => ({
    op: 'insert' as const,
    block: `b${randomUUID().slice(0, 8)}`,
    after: null,
    kind: 'section' as const,
    content: 'Новый',
    props: { heading: 'Ещё' },
  })

  it('gives each role what it may, and a stranger nothing (the matrix «role × path»)', async () => {
    const { viewer, editor, stranger, as, artifactId } = await shared()
    const viewLink = await as.owner.artifact.shareLink({ artifactId, role: 'view', term: null })
    await expect(as.viewer.artifact.shareOpen({ token: viewLink.token })).resolves.toEqual({
      artifactId,
      role: 'view',
    })
    // A new link revokes the one before: Борис keeps nothing of it, Вера gets «Правит».
    const editLink = await as.owner.artifact.shareLink({ artifactId, role: 'edit', term: 30 })
    expect(editLink.expiresAt).not.toBeNull()
    await expect(as.editor.artifact.shareOpen({ token: editLink.token })).resolves.toEqual({
      artifactId,
      role: 'edit',
    })
    await expect(as.viewer.artifact.read({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(as.viewer.artifact.shareOpen({ token: viewLink.token })).rejects.toMatchObject({
      cause: { code: 'ARTIFACT_LINK_GONE' },
    })
    await expect(as.viewer.artifact.shareOpen({ token: editLink.token })).resolves.toMatchObject({
      role: 'edit',
    })
    await as.owner.artifact.shareSetRole({ artifactId, recipientId: viewer.id, role: 'view' })

    const write = (caller: ReturnType<typeof callerOf>) =>
      caller.artifact.write({ batch: { artifactId, opId: randomUUID(), ops: [insertOp()] } })
    const outsider = callerOf(stranger)

    // read
    for (const caller of [as.owner, as.viewer, as.editor])
      expect((await caller.artifact.read({ artifactId })).id).toBe(artifactId)
    expect((await as.viewer.artifact.read({ artifactId })).role).toBe('view')
    expect((await as.editor.artifact.read({ artifactId })).role).toBe('edit')
    await expect(outsider.artifact.read({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    // write
    await expect(write(as.editor)).resolves.toMatchObject({ artifactId })
    await expect(write(as.viewer)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(write(outsider)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // the owner's alone: access, the trash, a project, private notes, the page
    for (const caller of [as.viewer, as.editor, outsider]) {
      await expect(caller.artifact.shareState({ artifactId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
      await expect(
        caller.artifact.shareLink({ artifactId, role: 'view', term: null }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(caller.artifact.trash({ artifactId })).rejects.toBeTruthy()
      await expect(caller.artifact.move({ artifactId, projectId: null })).rejects.toBeTruthy()
      await expect(caller.artifact.comments({ artifactId })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      })
    }
    // «Доступные мне», without the owner's project
    expect(await as.viewer.artifact.list({ filter: 'shared' })).toMatchObject([
      { id: artifactId, project: null },
    ])
    expect(await outsider.artifact.list({ filter: 'shared' })).toEqual([])
    // what the owner sees
    const state = await as.owner.artifact.shareState({ artifactId })
    expect(state.link).toMatchObject({ role: 'edit', opens: 2 })
    expect(
      state.people
        .map(({ name, role }) => ({ name, role }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    ).toEqual([
      { name: 'Борис', role: 'view' },
      { name: 'Вера', role: 'edit' },
    ])
    expect(state.people.find((p) => p.userId === editor.id)?.email).toBe(editor.email)
  })

  it('takes access away with the link, its term, the recipient, «Выйти» and «Закрыть доступ всем»', async () => {
    const { owner, editor, viewer, as, artifactId } = await shared()
    const { token } = await as.owner.artifact.shareLink({ artifactId, role: 'view', term: 7 })
    await as.viewer.artifact.shareOpen({ token })
    await as.editor.artifact.shareOpen({ token })
    // The owner opens their own link as the owner, never as a recipient.
    await expect(as.owner.artifact.shareOpen({ token })).resolves.toMatchObject({ role: 'owner' })

    await as.owner.artifact.shareRemove({ artifactId, recipientId: viewer.id })
    await expect(as.viewer.artifact.read({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(as.editor.artifact.shareLeave({ artifactId })).resolves.toEqual({ left: true })
    await expect(as.editor.artifact.read({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })

    // An expired link gives nothing, and what it gave lapses with it.
    await as.viewer.artifact.shareOpen({ token })
    await db.artifactLink.updateMany({
      where: { artifactId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    await expect(as.viewer.artifact.read({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(as.viewer.artifact.shareOpen({ token })).rejects.toMatchObject({
      cause: { code: 'ARTIFACT_LINK_GONE' },
    })

    const fresh = await as.owner.artifact.shareLink({ artifactId, role: 'edit', term: null })
    await as.editor.artifact.shareOpen({ token: fresh.token })
    // The trash is the owner's alone: a recipient opens nothing deleted, and gets it back with it.
    await as.owner.artifact.trash({ artifactId })
    await expect(as.editor.artifact.read({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await as.owner.artifact.restore({ artifactId })
    expect((await as.editor.artifact.read({ artifactId })).role).toBe('edit')

    await expect(as.owner.artifact.shareCloseAll({ artifactId })).resolves.toEqual({
      links: 1,
      // Вера's by the live link, and Борис's row of the expired one.
      grants: 2,
    })
    await expect(as.editor.artifact.read({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await expect(as.editor.artifact.shareOpen({ token: fresh.token })).rejects.toMatchObject({
      cause: { code: 'ARTIFACT_LINK_GONE' },
    })
    expect((await as.owner.artifact.shareState({ artifactId })).people).toEqual([])
    expect(owner.id).not.toBe(editor.id)
  })

  it('opens to nobody in production until the flag is on', async () => {
    const { owner, artifactId } = await shared()
    await expect(
      callerOf(owner, 'production').artifact.shareLink({ artifactId, role: 'view', term: null }),
    ).rejects.toMatchObject({ cause: { code: 'ARTIFACT_SHARING_CLOSED' } })
  })
})
