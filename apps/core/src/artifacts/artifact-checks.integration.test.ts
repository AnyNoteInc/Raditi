import { randomUUID } from 'node:crypto'

import {
  applyArtifactOps,
  claimArtifactBlock,
  createArtifact,
  createPrismaClient,
  readArtifact,
  type ArtifactActor,
  type PrismaClient,
} from '@repo/db'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { ARTIFACT_STALE_WRITE_MS, ArtifactChecks } from './artifact-checks.ts'

// The check of the agent's text in artifacts on PostgreSQL (docs/plan/88-artifacts.md, Ар16, Ар19,
// slice 88.4): rows of its own, removed at the end.

const databaseUrl = process.env.DATABASE_URL
const VALUE = 'synthetic-client-value-0002'
const refuses = (text: string) => (text.includes(VALUE) ? ('client_value' as const) : null)

describe.skipIf(!databaseUrl)(
  'the check of the agent’s writes in artifacts with PostgreSQL',
  () => {
    let db: PrismaClient
    let userId: string
    let workspaceId: string
    const quiet = { log: vi.fn(), warn: vi.fn() }

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
      userId = (
        await db.user.create({ data: { name: 'Synthetic', email: `${randomUUID()}@example.test` } })
      ).id
      workspaceId = (
        await db.workspace.create({
          data: { name: 'Synthetic artifacts', dataClass: 'synthetic', createdById: userId },
        })
      ).id
      await db.member.create({ data: { workspaceId, userId, role: 'owner' } })
    })
    afterAll(async () => {
      if (!db) return
      await db.artifact.deleteMany({ where: { workspaceId } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.member.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
      await db.user.delete({ where: { id: userId } })
      await db.$disconnect()
    })

    const person = (): ArtifactActor => ({ kind: 'user', userId })
    const agent = (taskId: string): ArtifactActor => ({ kind: 'agent', taskId, turnNo: 1 })
    const chat = async (status: 'running' | 'failed' = 'running') =>
      (
        await db.task.create({
          data: { workspaceId, createdById: userId, status },
          select: { id: true },
        })
      ).id
    /** After the lease of the person who wrote the start (30 s). */
    const later = () => new Date(Date.now() + 60_000)
    async function document() {
      const { id } = await createArtifact(db, {
        workspaceId,
        kind: 'document',
        title: 'Прайс',
        actor: person(),
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
              content: 'Капучино — 250 ₽',
              props: { heading: 'Кофе' },
            },
            {
              op: 'insert',
              block: 'b',
              after: 'a',
              kind: 'section',
              content: 'Чай — 150 ₽',
              props: { heading: 'Чай' },
            },
          ],
        },
        actor: person(),
      })
      return id
    }
    const write = (id: string, taskId: string, ops: unknown[]) =>
      applyArtifactOps(db, {
        batch: { artifactId: id, opId: randomUUID(), ops },
        actor: agent(taskId),
        now: later(),
      })
    const contents = async (id: string) =>
      (await readArtifact(db, { artifactId: id, actor: person() })).blocks.map((block) => [
        block.key,
        block.content,
        block.checking,
      ])

    it('shows a passed write at once while the turn runs, and keeps the text before a refused one', async () => {
      const checks = new ArtifactChecks({ db, logger: quiet })
      const id = await document()
      const taskId = await chat()
      await write(id, taskId, [
        { op: 'replace', block: 'a', ifRev: 1, content: 'Капучино — 270 ₽' },
        { op: 'replace', block: 'b', ifRev: 1, content: `Чай — ${VALUE}` },
        { op: 'title', title: 'Прайс на зиму' },
      ])
      expect(await contents(id)).toEqual([
        ['a', 'Капучино — 250 ₽', true],
        ['b', 'Чай — 150 ₽', true],
      ])
      const outcome = await checks.checkLive(taskId, 1, refuses)
      expect(outcome).toEqual({ checked: 2, refused: 1, dropped: 0 })
      expect(await contents(id)).toEqual([
        ['a', 'Капучино — 270 ₽', false],
        ['b', 'Чай — 150 ₽', false],
      ])
      expect((await db.artifact.findUniqueOrThrow({ where: { id } })).title).toBe('Прайс на зиму')
      // Nothing is left to check: the next tick writes nothing.
      expect(await checks.checkLive(taskId, 1, refuses)).toEqual({
        checked: 0,
        refused: 0,
        dropped: 0,
      })
    })

    it('checks a claim’s intent and a refused title, and ends the claims at the end of the turn', async () => {
      const checks = new ArtifactChecks({ db, logger: quiet })
      const id = await document()
      const taskId = await chat()
      await claimArtifactBlock(db, {
        artifactId: id,
        block: 'a',
        actor: { kind: 'agent', taskId, turnNo: 1 },
        intent: `Вставлю ${VALUE}`,
        now: later(),
      })
      await claimArtifactBlock(db, {
        artifactId: id,
        block: 'b',
        actor: { kind: 'agent', taskId, turnNo: 1 },
        intent: 'Обновлю цены',
        now: later(),
      })
      await write(id, taskId, [{ op: 'title', title: `Ключ ${VALUE}` }])
      await checks.checkLive(taskId, 1, refuses)
      const leases = await db.artifactBlock.findMany({
        where: { documentId: id },
        orderBy: { sectionKey: 'asc' },
        select: { leaseIntent: true, leaseIntentChecked: true, leaseHolder: true },
      })
      expect(leases).toEqual([
        { leaseIntent: null, leaseIntentChecked: false, leaseHolder: 'agent' },
        { leaseIntent: 'Обновлю цены', leaseIntentChecked: true, leaseHolder: 'agent' },
      ])
      const titled = await db.artifact.findUniqueOrThrow({ where: { id } })
      expect([titled.title, titled.pendingTitle]).toEqual(['Прайс', null])
      await checks.settle(taskId, 1, refuses)
      expect(
        await db.artifactBlock.count({ where: { documentId: id, leaseHolder: 'agent' } }),
      ).toBe(0)
    })

    it('a failed turn keeps what passes with its values and drops the rest; without values — all', async () => {
      const checks = new ArtifactChecks({ db, logger: quiet })
      const id = await document()
      const taskId = await chat()
      await write(id, taskId, [
        { op: 'replace', block: 'a', ifRev: 1, content: 'Капучино — 300 ₽' },
      ])
      expect(await checks.fail(taskId, 1, refuses)).toEqual({ checked: 1, refused: 0, dropped: 0 })
      expect((await contents(id))[0]).toEqual(['a', 'Капучино — 300 ₽', false])
      const second = await chat()
      await write(id, second, [
        { op: 'replace', block: 'b', ifRev: 1, content: 'Чай — 180 ₽' },
        {
          op: 'insert',
          block: 'c',
          after: 'b',
          kind: 'section',
          content: 'Какао',
          props: { heading: 'Какао' },
        },
      ])
      expect(await checks.fail(second, 1, null)).toEqual({ checked: 0, refused: 0, dropped: 2 })
      expect(await contents(id)).toEqual([
        ['a', 'Капучино — 300 ₽', false],
        ['b', 'Чай — 150 ₽', false],
      ])
    })

    it('the sweep drops the writes of a chat whose pass is over, by the time of the write', async () => {
      let now = new Date()
      const checks = new ArtifactChecks({ db, logger: quiet, now: () => now })
      const id = await document()
      const running = await chat('running')
      const over = await chat('failed')
      await write(id, running, [{ op: 'replace', block: 'a', ifRev: 1, content: 'x' }])
      await write(id, over, [{ op: 'replace', block: 'b', ifRev: 1, content: 'y' }])
      expect(await checks.sweep()).toBe(0)
      now = new Date(Date.now() + 60_000 + ARTIFACT_STALE_WRITE_MS + 1_000)
      expect(await checks.sweep({ busy: () => false })).toBe(1)
      expect(await contents(id)).toEqual([
        ['a', 'Капучино — 250 ₽', true],
        ['b', 'Чай — 150 ₽', false],
      ])
      // A chat this core runs is left alone, whatever its row says.
      await db.task.update({ where: { id: running }, data: { status: 'failed' } })
      expect(await checks.sweep({ busy: (taskId) => taskId === running })).toBe(0)
    })
  },
)
