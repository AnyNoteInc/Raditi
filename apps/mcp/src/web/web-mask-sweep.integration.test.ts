import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { contentMaskPath } from '../privacy/content-privacy.ts'
import { CONTENT_SNAPSHOT_TTL_MS } from '../privacy/content-expiry.ts'
import { WebMaskSweep } from './web-mask-sweep.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const HOUR = 3_600_000

describe.skipIf(!enabled)('the sweep of contact maps with PostgreSQL', () => {
  let db: PrismaClient
  let f: {
    workspaceId: string
    siteId: string
    driverId: string
    providerId: string
    modelId: string
    credentialId: string
    accountId: string
  }
  const tasks: string[] = []
  const paths = new Set<string>()
  /** Paths whose next removal goes through and is reported as lost. */
  const lost = new Set<string>()
  const secrets = {
    kvDestroyAll: vi.fn(async (path: string) => {
      paths.add(path)
      if (lost.delete(path)) throw new Error('Synthetic lost acknowledgement')
    }),
  }

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  beforeEach(async () => {
    paths.clear()
    secrets.kvDestroyAll.mockClear()
    const suffix = randomBytes(8).toString('hex')
    f = await db.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: 'Synthetic masks', dataClass: 'synthetic' },
      })
      const site = await tx.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic masks',
          url: `https://${suffix}.example.test`,
          stack: 'wordpress',
          status: 'active',
        },
      })
      const driver = await tx.agentDriver.create({
        data: {
          id: `mask-${suffix}`,
          image: `synthetic@sha256:${'a'.repeat(64)}`,
          capabilities: {},
          enabled: true,
        },
      })
      const provider = await tx.llmProvider.create({
        data: { slug: `mask-${suffix}`, name: 'Synthetic', kind: 'subscription' },
      })
      const model = await tx.llmModel.create({
        data: {
          providerId: provider.id,
          slug: `mask-${suffix}`,
          name: 'Synthetic',
          modelClass: 'standard',
          reserveOutputTokens: 1024,
        },
      })
      const credential = await tx.credentialRef.create({
        data: { kind: 'subscription', vaultPath: `subs/synthetic/${suffix}` },
      })
      const account = await tx.subscriptionAccount.create({
        data: {
          providerId: provider.id,
          driverId: driver.id,
          label: `mask-${suffix}`,
          plan: 'synthetic',
          credentialRefId: credential.id,
          maxConcurrentTurns: 1,
          maxConcurrentRequests: 1,
        },
      })
      return {
        workspaceId: workspace.id,
        siteId: site.id,
        driverId: driver.id,
        providerId: provider.id,
        modelId: model.id,
        credentialId: credential.id,
        accountId: account.id,
      }
    })
  })

  afterEach(async () => {
    await db.llmKey.deleteMany({ where: { taskId: { in: tasks } } })
    await db.turnAssignment.deleteMany({ where: { taskId: { in: tasks } } })
    await db.task.deleteMany({ where: { id: { in: tasks } } })
    tasks.length = 0
    await db.subscriptionAccount.delete({ where: { id: f.accountId } })
    await db.credentialRef.delete({ where: { id: f.credentialId } })
    await db.llmModel.delete({ where: { id: f.modelId } })
    await db.llmProvider.delete({ where: { id: f.providerId } })
    await db.agentDriver.delete({ where: { id: f.driverId } })
    await db.site.delete({ where: { id: f.siteId } })
    await db.workspace.delete({ where: { id: f.workspaceId } })
  })

  /** A task with a browser that reached a final status longer ago than the window. */
  async function task(
    data: {
      site?: boolean
      needsRepository?: boolean
      needsBrowser?: boolean
      status?: 'done' | 'failed' | 'cancelled' | 'rolled_back' | 'awaiting_user'
      finishedAgoMs?: number
      purgedByContent?: boolean
    } = {},
  ) {
    const { site = true, needsRepository = false, needsBrowser = true } = data
    const row = await db.task.create({
      data: {
        workspaceId: f.workspaceId,
        ...(site ? { siteId: f.siteId } : {}),
        status: data.status ?? 'done',
        needsRepository,
        needsBrowser,
        finishedAt: new Date(Date.now() - (data.finishedAgoMs ?? CONTENT_SNAPSHOT_TTL_MS + HOUR)),
        ...(data.purgedByContent
          ? { contentRetiredAt: new Date(), contentMasksPurgedAt: new Date() }
          : {}),
      },
    })
    tasks.push(row.id)
    return row
  }

  const pathOf = (row: { id: string; siteId: string | null }) =>
    contentMaskPath({ siteId: row.siteId ?? row.id, taskId: row.id })
  const sweep = () => new WebMaskSweep(db, secrets).sweep()
  const read = (id: string) => db.task.findUniqueOrThrow({ where: { id } })

  it('removes the map of a finished task once its window is over', async () => {
    for (const status of ['done', 'failed', 'cancelled', 'rolled_back'] as const) {
      const row = await task({ status })
      await sweep()
      expect(paths).toContain(pathOf(row))
      expect((await read(row.id)).webMasksPurgedAt).not.toBeNull()
    }
  })

  it('removes the map of a chat without a site from under its own id, with no lease to read', async () => {
    const chat = await task({ site: false })
    await sweep()
    expect(paths).toContain(`kv/content-masks/${chat.id}/${chat.id}`)
    expect((await read(chat.id)).webMasksPurgedAt).not.toBeNull()
  })

  it('comes to a task once, and leaves the chat where it stands in its list', async () => {
    const row = await task()
    await sweep()
    const swept = await read(row.id)
    expect(swept.updatedAt).toEqual(row.updatedAt)
    secrets.kvDestroyAll.mockClear()
    await sweep()
    expect(secrets.kvDestroyAll).not.toHaveBeenCalledWith(pathOf(row))
  })

  it('leaves the artifacts of a repository task to their own sweep, in full', async () => {
    const row = await task({ needsRepository: true })
    await sweep()
    expect(paths).toContain(pathOf(row))
    const swept = await read(row.id)
    expect(swept.webMasksPurgedAt).not.toBeNull()
    // Set, it would close the removal of the artifacts; retired, its claim would skip its checks.
    expect(swept.contentMasksPurgedAt).toBeNull()
    expect(swept.contentRetiredAt).toBeNull()
  })

  it('does not touch what is not due', async () => {
    const rows = await Promise.all([
      task({ finishedAgoMs: CONTENT_SNAPSHOT_TTL_MS - HOUR }),
      // An open chat keeps its map: it may go on (plan 61, §9, вопрос 9).
      task({ status: 'awaiting_user' }),
      task({ needsRepository: true, needsBrowser: false }),
      task({ purgedByContent: true }),
    ])
    await sweep()
    for (const row of rows) {
      expect(paths).not.toContain(pathOf(row))
      expect((await read(row.id)).webMasksPurgedAt).toBeNull()
    }
  })

  it('waits for an unfinished assignment', async () => {
    const row = await task()
    const assignment = await db.turnAssignment.create({
      data: {
        taskId: row.id,
        siteId: f.siteId,
        sessionId: 'synthetic',
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + HOUR),
      },
    })
    await sweep()
    expect(paths).not.toContain(pathOf(row))
    expect((await read(row.id)).webMasksPurgedAt).toBeNull()
    await db.turnAssignment.update({
      where: { id: assignment.id },
      data: { finishedAt: new Date(), outcome: 'completed' },
    })
    await sweep()
    expect(paths).toContain(pathOf(row))
  })

  it('waits for a live key', async () => {
    const row = await task()
    const key = await db.llmKey.create({
      data: {
        keyHash: createHash('sha256').update(randomUUID()).digest('hex'),
        taskId: row.id,
        taskAttempt: 1,
        sessionId: 'synthetic',
        turnNo: 1,
        firstEpoch: 1,
        driverId: f.driverId,
        modelId: f.modelId,
        subscriptionAccountId: f.accountId,
        budgetRub: '100',
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + HOUR),
        validUntil: new Date(Date.now() + HOUR),
      },
    })
    await sweep()
    expect(paths).not.toContain(pathOf(row))
    await db.llmKey.update({
      where: { id: key.id },
      data: { revokeRequestedAt: new Date(), revokedAt: new Date() },
    })
    await sweep()
    expect(paths).toContain(pathOf(row))
  })

  it('repeats a removal whose acknowledgement was lost', async () => {
    const row = await task()
    lost.add(pathOf(row))
    expect((await sweep()).failed).toBeGreaterThanOrEqual(1)
    expect((await read(row.id)).webMasksPurgedAt).toBeNull()
    secrets.kvDestroyAll.mockClear()
    await sweep()
    expect(secrets.kvDestroyAll).toHaveBeenCalledWith(pathOf(row))
    expect((await read(row.id)).webMasksPurgedAt).not.toBeNull()
  })
})
