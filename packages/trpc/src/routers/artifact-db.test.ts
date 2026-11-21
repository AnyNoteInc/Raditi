import { randomUUID } from 'node:crypto'

import {
  applyArtifactOps,
  claimArtifactBlock,
  createArtifact,
  createPrismaClient,
  settleArtifactWrites,
  trashArtifact,
  type PrismaClient,
  type User,
} from '@repo/db'
import { legalDocuments, type ObjectStorage, type SecretStore } from '@repo/domain'
import type { ArtifactPresenceMark, ArtifactSignal } from '@repo/domain/artifacts'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createCaller } from '../router.ts'
import { readArtifactSignals, type ArtifactSignals } from '../services/artifacts/signals.ts'
import type { ChatContext } from '../services/chat/context.ts'

// The live channel and presence of artifacts on PostgreSQL (docs/plan/88-artifacts.md, Ар20,
// slice 88.5): the role decides who may listen and be seen; presence is a fake of Redis.

const databaseUrl = process.env.DATABASE_URL

const requiredConsents = legalDocuments.flatMap((document) =>
  document.required && document.consentType
    ? [{ documentType: document.consentType, documentVersion: document.version, granted: true }]
    : [],
)

/** Redis of web as the procedures see it: listeners and marks in memory. */
function fakeSignals() {
  const listeners = new Map<string, Set<(signal: ArtifactSignal) => void>>()
  const marks = new Map<string, Map<string, ArtifactPresenceMark>>()
  const signals: ArtifactSignals = {
    subscribe(artifactId, listener) {
      const set = listeners.get(artifactId) ?? new Set()
      listeners.set(artifactId, set)
      set.add(listener)
      return () => set.delete(listener)
    },
    async mark(artifactId, userId, mark) {
      const map = marks.get(artifactId) ?? new Map()
      marks.set(artifactId, map)
      map.set(userId, mark)
    },
    async leave(artifactId, userId) {
      marks.get(artifactId)?.delete(userId)
    },
    async marks(artifactId) {
      return new Map(marks.get(artifactId) ?? [])
    },
  }
  const say = (artifactId: string, signal: ArtifactSignal) => {
    for (const listener of listeners.get(artifactId) ?? []) listener(signal)
  }
  return { signals, say, listeners }
}

describe.skipIf(!databaseUrl)('PostgreSQL: the signals and presence of artifacts', () => {
  let db: PrismaClient
  const userIds: string[] = []

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterEach(async () => {
    const users = userIds.splice(0)
    const owned = {
      workspaceId: {
        in: (
          await db.workspace.findMany({
            where: { createdById: { in: users } },
            select: { id: true },
          })
        ).map(({ id }) => id),
      },
    }
    await db.artifact.deleteMany({ where: owned })
    await db.task.deleteMany({ where: owned })
    await db.member.deleteMany({ where: owned })
    await db.workspace.deleteMany({ where: { id: owned.workspaceId } })
    await db.user.deleteMany({ where: { id: { in: users } } })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function person(name: string): Promise<User> {
    const row = await db.user.create({
      data: { name, email: `${randomUUID()}@artifacts.example.ru` },
    })
    userIds.push(row.id)
    await db.userConsent.createMany({
      data: requiredConsents.map((consent) => ({ ...consent, userId: row.id, source: 'sign_up' })),
    })
    return row
  }

  async function owned() {
    const user = await person('Анна')
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic', dataClass: 'synthetic', createdById: user.id },
    })
    await db.member.create({ data: { workspaceId: workspace.id, userId: user.id, role: 'owner' } })
    const { id } = await createArtifact(db, {
      workspaceId: workspace.id,
      kind: 'document',
      title: 'Прайс',
      actor: { kind: 'user', userId: user.id },
    })
    await applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [
          {
            op: 'insert',
            block: 'a',
            after: null,
            kind: 'section',
            content: 'Текст',
            props: { heading: 'А' },
          },
          {
            op: 'insert',
            block: 'b',
            after: 'a',
            kind: 'section',
            content: 'Ещё',
            props: { heading: 'Б' },
          },
        ],
      },
      actor: { kind: 'user', userId: user.id },
    })
    return { user, workspace, id }
  }

  function callerOf(user: User, artifacts: ArtifactSignals | null) {
    const chat: ChatContext = {
      appEnv: 'test',
      browser: null,
      storage: () => ({ get: async () => null }) as unknown as ObjectStorage,
      secrets: () => ({ transitEnsureKey: async () => {} }) as unknown as SecretStore,
      artifacts,
    }
    return createCaller({
      prisma: db,
      headers: new Headers(),
      user,
      session: {
        id: randomUUID(),
        userId: user.id,
        token: `artifacts-test-${randomUUID()}`,
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

  it('streams the signals of the artifacts a reader may read, and stops once none is left', async () => {
    const { user, id } = await owned()
    const stranger = await person('Борис')
    const { signals, say, listeners } = fakeSignals()
    await expect(async () => {
      for await (const _ of readArtifactSignals(db, signals, {
        userId: stranger.id,
        artifactIds: [id],
      }))
        break
    }).rejects.toMatchObject({ code: 'ARTIFACT_NOT_FOUND' })
    const abort = new AbortController()
    const stream = readArtifactSignals(db, signals, {
      userId: user.id,
      artifactIds: [id, randomUUID()],
      signal: abort.signal,
      recheckMs: 50,
    })
    expect((await stream.next()).value).toEqual({ artifactId: null, signal: 'resync' })
    say(id, 'changes')
    say(id, 'changes')
    say(id, 'presence')
    expect((await stream.next()).value).toEqual({ artifactId: id, signal: 'changes' })
    expect((await stream.next()).value).toEqual({ artifactId: id, signal: 'presence' })
    await trashArtifact(db, { artifactId: id, userId: user.id, by: 'client' })
    // The next recheck finds the artifact in the trash: the stream ends and stops listening.
    expect((await stream.next()).done).toBe(true)
    expect(listeners.get(id)?.size ?? 0).toBe(0)
    abort.abort()
  })

  it('shows people by their marks and agents by what they write, naming only one’s own chat', async () => {
    const { user, workspace, id } = await owned()
    const { signals } = fakeSignals()
    const caller = callerOf(user, signals)
    const own = await db.task.create({
      data: { workspaceId: workspace.id, createdById: user.id, title: 'Цены на зиму' },
      select: { id: true },
    })
    const later = new Date(Date.now() + 60_000)
    await applyArtifactOps(db, {
      batch: {
        artifactId: id,
        opId: randomUUID(),
        ops: [{ op: 'replace', block: 'a', ifRev: 1, content: 'Новый' }],
      },
      actor: { kind: 'agent', taskId: own.id, turnNo: 1 },
      now: later,
    })
    await claimArtifactBlock(db, {
      artifactId: id,
      block: 'b',
      actor: { kind: 'agent', taskId: own.id, turnNo: 1 },
      intent: 'Обновлю цены',
      now: later,
    })
    const first = await caller.artifact.here({ artifactId: id, block: 'a' })
    expect(first.people).toEqual([{ userId: user.id, name: 'Анна', block: 'a', self: true }])
    expect(first.agents).toEqual([
      {
        label: 'Цены на зиму',
        own: true,
        blocks: [
          { key: 'a', intent: null },
          // Not checked yet: nobody reads the intent.
          { key: 'b', intent: null },
        ],
      },
    ])
    await settleArtifactWrites(db, {
      taskId: own.id,
      blocks: [],
      claims: [{ artifactId: id, block: 'b', intent: 'Обновлю цены', refusal: null }],
    })
    const second = await caller.artifact.presence({ artifactId: id })
    expect(second.agents[0]?.blocks[1]).toEqual({ key: 'b', intent: 'Обновлю цены' })
    await caller.artifact.leave({ artifactId: id })
    expect((await caller.artifact.presence({ artifactId: id })).people).toEqual([])
    // Without Redis nobody is shown, and nothing fails.
    expect(await callerOf(user, null).artifact.here({ artifactId: id, block: null })).toEqual({
      people: [],
      morePeople: 0,
      agents: [],
    })
  })

  it('refuses presence and leaving to someone who may not read the artifact', async () => {
    const { id } = await owned()
    const stranger = await person('Борис')
    const { signals } = fakeSignals()
    await expect(
      callerOf(stranger, signals).artifact.here({ artifactId: id, block: null }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(
      callerOf(stranger, signals).artifact.leave({ artifactId: id }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
