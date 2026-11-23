import { randomUUID } from 'node:crypto'

import {
  applyArtifactOps,
  attachMentionedArtifacts,
  chatArtifactAccess,
  collectOriFactKeys,
  createPrismaClient,
  exportOriJournals,
  listChatArtifacts,
  recordOriFact,
  recordOriFactPorts,
  sweepOriJournals,
  type PrismaClient,
  type User,
} from '@repo/db'
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
    // Only this suite's notices: other suites write theirs to the same database at once.
    const artifacts = await db.artifact.findMany({ where: owned, select: { id: true } })
    if (artifacts.length > 0)
      await db.outboxEvent.deleteMany({
        where: {
          type: 'artifact.notify',
          OR: artifacts.map(({ id }) => ({ payload: { path: ['artifactId'], equals: id } })),
        },
      })
    await db.artifact.deleteMany({ where: owned })
    await db.creditLedger.deleteMany({ where: { account: owned } })
    await db.creditHold.deleteMany({ where: { account: owned } })
    await db.billingAccount.deleteMany({ where: owned })
    await db.auditLog.deleteMany({ where: owned })
    await db.member.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.rateLimit.deleteMany({ where: { key: { startsWith: 'artifact-open' } } })
    await db.outboxEvent.deleteMany({ where: { dedupeKey: { startsWith: 'artifact.invite:' } } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function person(name: string, emailVerified = true): Promise<User> {
    const row = await db.user.create({
      data: { name, email: `${randomUUID()}@artifacts-access.example.ru`, emailVerified },
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
      appUrl: 'https://raditi.test',
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
      // A recipient reads only threads of all (88.17a): the owner's private notes never.
      if (caller === outsider)
        await expect(caller.artifact.comments({ artifactId })).rejects.toMatchObject({
          code: 'NOT_FOUND',
        })
      else expect(await caller.artifact.comments({ artifactId })).toEqual([])
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

  it('opens in production once the flag is on (after v1.77.0)', async () => {
    const { owner, artifactId } = await shared()
    await expect(
      callerOf(owner, 'production').artifact.shareLink({ artifactId, role: 'view', term: null }),
    ).resolves.toMatchObject({ token: expect.any(String) })
  })

  it('invites by an address, sends our words only, and opens to that confirmed address alone (88.16-2)', async () => {
    const { owner, viewer, editor, as, artifactId } = await shared()
    // The address as typed: the owner sees it, the letter goes whether it has an account or not.
    await expect(
      as.owner.artifact.shareInvite({
        artifactId,
        email: viewer.email.toUpperCase(),
        role: 'edit',
      }),
    ).resolves.toEqual({ sent: true })
    await as.owner.artifact.shareInvite({
      artifactId,
      email: 'nobody-yet@artifacts-access.example.ru',
      role: 'view',
    })
    const state = await as.owner.artifact.shareState({ artifactId })
    expect(state.invites.map(({ email, role }) => ({ email, role }))).toEqual([
      { email: viewer.email.toLowerCase(), role: 'edit' },
      { email: 'nobody-yet@artifacts-access.example.ru', role: 'view' },
    ])
    // This test's letters only, in no order: other suites invite at the same time.
    const addresses = [viewer.email.toLowerCase(), 'nobody-yet@artifacts-access.example.ru']
    const letters = (
      await db.outboxEvent.findMany({
        where: { type: 'artifact.invite', dedupeKey: { startsWith: 'artifact.invite:' } },
        select: { payload: true },
      })
    ).filter((row) => addresses.includes((row.payload as { to: string }).to))
    expect(letters).toHaveLength(2)
    const toViewer = letters.find((row) => (row.payload as { to: string }).to === addresses[0])
    expect(toViewer!.payload).toMatchObject({
      to: viewer.email.toLowerCase(),
      inviterName: 'Анна',
      kindWord: 'документ',
      url: 'https://raditi.test/artifacts?invites=1',
    })
    expect(JSON.stringify(letters)).not.toContain('План')
    // An owner never invites themselves.
    await expect(
      as.owner.artifact.shareInvite({ artifactId, email: owner.email, role: 'view' }),
    ).rejects.toMatchObject({ cause: { code: 'ARTIFACT_GRANT_REFUSED' } })

    // Only the confirmed owner of the address sees it and accepts it.
    expect(await as.editor.artifact.myInvites()).toEqual([])
    const [invite] = await as.viewer.artifact.myInvites()
    expect(invite).toMatchObject({ artifactId, title: 'План', ownerName: 'Анна', role: 'edit' })
    await expect(
      as.editor.artifact.inviteAccept({ inviteId: invite!.inviteId }),
    ).rejects.toMatchObject({ cause: { code: 'ARTIFACT_INVITE_GONE' } })
    await expect(as.viewer.artifact.inviteAccept({ inviteId: invite!.inviteId })).resolves.toEqual({
      artifactId,
      role: 'edit',
    })
    expect((await as.viewer.artifact.read({ artifactId })).role).toBe('edit')
    expect(
      (await db.artifactInvite.findUniqueOrThrow({ where: { id: invite!.inviteId } })).email,
    ).toBeNull()
    await expect(
      as.viewer.artifact.inviteAccept({ inviteId: invite!.inviteId }),
    ).rejects.toMatchObject({ cause: { code: 'ARTIFACT_INVITE_GONE' } })

    // An unconfirmed address sees nothing.
    const unconfirmed = await person('Дина', false)
    await as.owner.artifact.shareInvite({ artifactId, email: unconfirmed.email, role: 'view' })
    expect(await callerOf(unconfirmed).artifact.myInvites()).toEqual([])
    // «Закрыть доступ всем» closes the waiting ones too.
    await as.owner.artifact.shareCloseAll({ artifactId })
    expect((await as.owner.artifact.shareState({ artifactId })).invites).toEqual([])
    expect(editor.id).not.toBe(viewer.id)
  })

  it('sends at most 10 invitations an artifact a day', async () => {
    const { as, artifactId } = await shared()
    for (let n = 0; n < 10; n++)
      await as.owner.artifact.shareInvite({
        artifactId,
        email: `guest-${n}-${randomUUID()}@artifacts-access.example.ru`,
        role: 'view',
      })
    await expect(
      as.owner.artifact.shareInvite({
        artifactId,
        email: `guest-11-${randomUUID()}@artifacts-access.example.ru`,
        role: 'view',
      }),
    ).rejects.toMatchObject({ cause: { code: 'ARTIFACT_LIMIT' } })
  })

  it('lets a recipient make a copy of their own only when the owner allows it (88.16-4)', async () => {
    const { viewer, as, artifactId } = await shared()
    const { token } = await as.owner.artifact.shareLink({ artifactId, role: 'view', term: null })
    await as.viewer.artifact.shareOpen({ token })
    expect(await as.viewer.artifact.shareMine({ artifactId })).toEqual({ copyAllowed: false })
    await expect(as.viewer.artifact.shareCopy({ artifactId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    await as.owner.artifact.shareSetCopy({ artifactId, allowed: true })
    expect((await as.owner.artifact.shareState({ artifactId })).copyAllowed).toBe(true)
    expect(await as.viewer.artifact.shareMine({ artifactId })).toEqual({ copyAllowed: true })
    const { id: copyId } = await as.viewer.artifact.shareCopy({ artifactId })
    const copy = await as.viewer.artifact.read({ artifactId: copyId })
    expect(copy).toMatchObject({ title: 'Копия: План', role: 'owner' })
    // The checked blocks as the recipient read them, in the canonical form of the source.
    const source = await as.viewer.artifact.read({ artifactId })
    const blocksOf = (read: typeof copy) =>
      read.blocks.map(({ key, content }) => ({ key, content }))
    expect(blocksOf(copy)).toEqual(blocksOf(source))
    expect(blocksOf(copy)).toHaveLength(1)
    // The copy is theirs: losing access to the source does not touch it.
    await as.owner.artifact.shareCloseAll({ artifactId })
    expect((await as.viewer.artifact.read({ artifactId: copyId })).id).toBe(copyId)
    await expect(as.owner.artifact.read({ artifactId: copyId })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    // A recipient's copy lands in their own workspace.
    const row = await db.artifact.findUniqueOrThrow({ where: { id: copyId } })
    expect(row.ownerUserId).toBe(viewer.id)
  })

  it('keeps the facts and messages of a shared artifact, append only (88.16а-1, Ар56)', async () => {
    const { owner, viewer, editor, as, artifactId } = await shared()
    const write = (caller: ReturnType<typeof callerOf>) =>
      caller.artifact.write({ batch: { artifactId, opId: randomUUID(), ops: [insertOp()] } })
    // Not shared yet: the owner's own writes are no messages between users.
    await write(as.owner)
    expect(await db.oriMessage.count({ where: { artifactId } })).toBe(0)

    const { token } = await as.owner.artifact.shareLink({ artifactId, role: 'edit', term: null })
    await as.editor.artifact.shareOpen({ token })
    await as.viewer.artifact.shareOpen({ token })
    const opened = await db.oriFact.findMany({
      where: { artifactId, kind: 'access_open' },
      orderBy: { id: 'asc' },
    })
    expect(opened.map((fact) => fact.userId)).toEqual([editor.id, viewer.id])
    expect(opened[0]!.addressees).toEqual([owner.id])

    await write(as.editor)
    const messages = await db.oriMessage.findMany({ where: { artifactId } })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ userId: editor.id, kind: 'write' })
    expect(JSON.parse(messages[0]!.content!)).toMatchObject({ op: 'insert', content: 'Новый\n' })
    expect([...messages[0]!.addressees].sort()).toEqual([owner.id, viewer.id].sort())
    const written = await db.oriFact.findFirstOrThrow({
      where: { artifactId, kind: 'artifact_write' },
    })
    // A fact never carries the content (Decree № 1526, p. 4).
    expect(JSON.stringify({ ...written, id: String(written.id) })).not.toContain('Новый')

    // Append only: neither an update nor a delete of a row within its term.
    await expect(
      db.$executeRaw`UPDATE ori_messages SET content = 'x' WHERE artifact_id = ${artifactId}::uuid`,
    ).rejects.toThrow(/append only/)
    await expect(
      db.$executeRaw`DELETE FROM ori_facts WHERE artifact_id = ${artifactId}::uuid`,
    ).rejects.toThrow(/append only/)
  })

  it('lets the collector delete only what is past its term', async () => {
    const userId = randomUUID()
    const longAgo = new Date(Date.now() - 4 * 365 * 24 * 60 * 60 * 1000)
    await recordOriFact(db, {
      kind: 'sign_in',
      userId,
      origin: { ip: '203.0.113.7' },
      now: longAgo,
    })
    await recordOriFact(db, { kind: 'sign_in', userId, origin: { ip: '203.0.113.8' } })
    const swept = await sweepOriJournals(db)
    expect(swept.facts).toBeGreaterThanOrEqual(1)
    const left = await db.oriFact.findMany({ where: { userId } })
    expect(left.map((fact) => fact.ip)).toEqual(['203.0.113.8'])
    // Without the collector's setting even an expired row stays.
    await expect(
      db.$executeRaw`DELETE FROM ori_facts WHERE user_id = ${userId}::uuid`,
    ).rejects.toThrow(/append only/)
  })

  it('brings the client’s port of a fact back from the edge by its random key (88.16а-2)', async () => {
    const userId = randomUUID()
    const { keys } = await collectOriFactKeys(() =>
      recordOriFact(db, { kind: 'sign_in', userId, origin: { ip: '203.0.113.9' } }),
    )
    expect(keys).toHaveLength(1)
    const edgeAt = new Date()
    const ports = [
      { edgeKey: keys[0]!, port: 59154, edgeAt },
      // A key no fact has (its transaction rolled back) is left out.
      { edgeKey: randomUUID(), port: 1, edgeAt },
    ]
    expect(await recordOriFactPorts(db, ports)).toBe(1)
    // The collector reads a line again after a failure: nothing twice.
    expect(await recordOriFactPorts(db, ports)).toBe(0)
    const day = 24 * 60 * 60 * 1000
    const exported = await exportOriJournals(db, {
      userId,
      from: new Date(Date.now() - day),
      to: new Date(Date.now() + day),
      messages: false,
    })
    expect(exported.facts).toMatchObject([{ kind: 'sign_in', ip: '203.0.113.9', port: 59154 }])
    // Our key is not the user's: it stays out of the export.
    expect(JSON.stringify(exported)).not.toContain(keys[0]!)
    await expect(
      db.$executeRaw`UPDATE ori_fact_ports SET port = 2 WHERE edge_key = ${keys[0]!}::uuid`,
    ).rejects.toThrow(/append only/)
  })

  it('lets a recipient’s agent open only an artifact the recipient attached, by their role (88.17)', async () => {
    const { viewer, editor, as, artifactId } = await shared()
    const { token } = await as.owner.artifact.shareLink({ artifactId, role: 'edit', term: null })
    await as.editor.artifact.shareOpen({ token })
    // A chat of the recipient, in their own personal workspace.
    await as.editor.artifact.create({
      kind: 'document',
      title: 'Своё',
      projectId: null,
      templateId: null,
    })
    const { id: workspaceId } = await db.workspace.findFirstOrThrow({
      where: { createdById: editor.id },
      select: { id: true },
    })
    const { id: taskId } = await db.task.create({
      data: {
        workspaceId,
        createdById: editor.id,
        status: 'running',
        turnNo: 1,
        modelClass: 'standard',
      },
      select: { id: true },
    })
    // Not attached yet: the chat neither opens nor lists it.
    expect(await chatArtifactAccess(db, { taskId, artifactId })).toBeNull()
    expect((await listChatArtifacts(db, { taskId })).rows.map((row) => row.id)).not.toContain(
      artifactId,
    )
    await expect(
      applyArtifactOps(db, {
        batch: { artifactId, opId: randomUUID(), ops: [insertOp()] },
        actor: { kind: 'agent', taskId, turnNo: 1 },
      }),
    ).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })
    // The recipient's own words name it: attached, by the role their grant gives.
    expect(await attachMentionedArtifacts(db, { taskId, artifactIds: [artifactId] })).toEqual([
      artifactId,
    ])
    expect(await chatArtifactAccess(db, { taskId, artifactId })).toEqual({
      role: 'edit',
      personal: false,
      linked: true,
    })
    expect((await listChatArtifacts(db, { taskId })).rows.map((row) => row.id)).toContain(
      artifactId,
    )
    await expect(
      applyArtifactOps(db, {
        batch: { artifactId, opId: randomUUID(), ops: [insertOp()] },
        actor: { kind: 'agent', taskId, turnNo: 1 },
      }),
    ).resolves.toMatchObject({ artifactId })
    // Access gone — the chat opens it no more, attached or not.
    await as.owner.artifact.shareRemove({ artifactId, recipientId: editor.id })
    expect(await chatArtifactAccess(db, { taskId, artifactId })).toBeNull()
    expect(viewer.id).not.toBe(editor.id)
    await db.task.delete({ where: { id: taskId } })
  })

  it('opens threads of all to everyone with access, writable by «Комментирует» (88.17а)', async () => {
    const { owner, viewer, editor, as, artifactId } = await shared()
    const view = await as.owner.artifact.shareLink({ artifactId, role: 'view', term: null })
    await as.viewer.artifact.shareOpen({ token: view.token })
    await as.owner.artifact.shareSetRole({ artifactId, recipientId: viewer.id, role: 'view' })
    // «Комментирует» by an invitation: a new link would revoke the one before.
    await as.owner.artifact.shareInvite({ artifactId, email: editor.email, role: 'comment' })
    const [invite] = await as.editor.artifact.myInvites()
    await as.editor.artifact.inviteAccept({ inviteId: invite!.inviteId })
    const read = await as.owner.artifact.read({ artifactId })
    const s1 = read.blocks.find((block) => block.key === 's1')!
    const anchor = { kind: 'quote' as const, block: 's1', rev: s1.rev, quote: 'Текст' }

    // The owner's private note stays theirs; a thread of all is seen by all.
    await as.owner.artifact.addComment({ artifactId, anchor, body: 'Себе' })
    const { id: threadId } = await as.owner.artifact.addComment({
      artifactId,
      anchor,
      body: 'Всем: проверьте цены',
      shared: true,
    })
    expect((await as.viewer.artifact.comments({ artifactId })).map((note) => note.body)).toEqual([
      'Всем: проверьте цены',
    ])
    expect(
      (await as.owner.artifact.comments({ artifactId })).map((note) => note.body).sort(),
    ).toEqual(['Всем: проверьте цены', 'Себе'])
    // «Смотрит» only reads; «Комментирует» writes a thread and replies.
    await expect(
      as.viewer.artifact.addComment({ artifactId, anchor, body: 'Я тоже', shared: true }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    await expect(
      as.viewer.artifact.addCommentReply({
        artifactId,
        threadId,
        requestId: randomUUID(),
        body: 'Ответ',
      }),
    ).rejects.toMatchObject({ cause: { code: 'ARTIFACT_COMMENT_UNAVAILABLE' } })
    await as.editor.artifact.addCommentReply({
      artifactId,
      threadId,
      requestId: randomUUID(),
      body: 'Цены верные',
    })
    const [thread] = await as.viewer.artifact.comments({ artifactId })
    expect(thread).toMatchObject({
      shared: true,
      author: { name: 'Анна', own: false },
      replies: [{ body: 'Цены верные', authorName: 'Вера', own: false }],
    })
    // A note of the owner is not anyone's to answer or close.
    const mine = (await as.owner.artifact.comments({ artifactId })).find((n) => n.body === 'Себе')!
    await expect(
      as.editor.artifact.resolveComment({ artifactId, commentId: mine.id, resolved: true }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // The thread and its reply are messages between users (Ар56).
    expect(
      (await db.oriMessage.findMany({ where: { artifactId, kind: 'comment' } })).map(
        (m) => m.content,
      ),
    ).toEqual(['Всем: проверьте цены', 'Цены верные'])
    expect(owner.id).not.toBe(editor.id)
  })

  it('asks core to tell the people of an artifact, without their words (Ар54)', async () => {
    const { owner, viewer, editor, as, artifactId } = await shared()
    const notices = async () =>
      (
        await db.outboxEvent.findMany({
          where: { type: 'artifact.notify', payload: { path: ['artifactId'], equals: artifactId } },
          orderBy: { createdAt: 'asc' },
          select: { payload: true },
        })
      ).map((row) => row.payload as { userId: string; kind: string; actorUserId: string | null })
    // An invitation to a confirmed address of a user: they hear of it.
    await as.owner.artifact.shareInvite({ artifactId, email: editor.email, role: 'edit' })
    const [invite] = await as.editor.artifact.myInvites()
    await as.editor.artifact.inviteAccept({ inviteId: invite!.inviteId })
    // Another person changed the owner's artifact: the owner hears of it.
    await as.editor.artifact.write({ batch: { artifactId, opId: randomUUID(), ops: [insertOp()] } })
    // A thread of all: everyone else with access hears of it.
    const view = await as.owner.artifact.shareLink({ artifactId, role: 'view', term: null })
    await as.viewer.artifact.shareOpen({ token: view.token })
    const read = await as.owner.artifact.read({ artifactId })
    const s1 = read.blocks.find((block) => block.key === 's1')!
    await as.editor.artifact.addComment({
      artifactId,
      anchor: { kind: 'quote', block: 's1', rev: s1.rev, quote: 'Текст' },
      body: 'Проверьте раздел',
      shared: true,
    })
    const sent = await notices()
    expect(sent).toEqual(
      expect.arrayContaining([
        { artifactId, userId: editor.id, kind: 'artifact_shared', actorUserId: owner.id },
        { artifactId, userId: owner.id, kind: 'artifact_changed', actorUserId: editor.id },
        { artifactId, userId: owner.id, kind: 'artifact_comment', actorUserId: editor.id },
        { artifactId, userId: viewer.id, kind: 'artifact_comment', actorUserId: editor.id },
      ]),
    )
    expect(JSON.stringify(sent)).not.toContain('Проверьте раздел')
    expect(sent.some((row) => row.userId === editor.id && row.kind === 'artifact_comment')).toBe(
      false,
    )
  })
})
