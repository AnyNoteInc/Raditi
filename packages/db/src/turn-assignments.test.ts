import { randomUUID } from 'node:crypto'

import type { SiteLeaseGrant, TurnPlan } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { PostgresSiteLeaseStore } from './site-leases.ts'
import { PostgresTurnAssignmentStore } from './turn-assignments.ts'

const databaseUrl = process.env.DATABASE_URL

function plan(taskId: string, sessionId: string, siteId: string): TurnPlan {
  return {
    sandbox: {
      image: `registry.invalid/raditi/codex@sha256:${'a'.repeat(64)}`,
      labels: { workspaceId: 'ws1', siteId, taskId, sessionId, turn: 1 },
      runtime: 'runc',
      resources: { cpu: 1, memoryMiB: 256, pids: 64 },
      user: { uid: 10001, gid: 10001 },
      env: {},
      secrets: [],
      network: { mode: 'none' },
      hardTimeoutMs: 600_000,
    },
    context: {
      taskId,
      sessionId,
      turn: 1,
      llm: { baseUrl: 'http://llm.invalid', model: 'synthetic' },
      mcp: { url: 'http://mcp.invalid/mcp' },
      instructions: 'Synthetic verification',
    },
    input: { prompt: 'Synthetic turn', attachments: [] },
    driverId: 'codex',
    driverVersion: '1.0.0',
    workspace: {
      repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
      branch: `agent/${taskId}`,
      expectedBaseSha: 'b'.repeat(40),
      protectedPaths: [],
    },
    committedAt: '2026-09-27T00:00:00.000Z',
  }
}

describe('turn assignment input validation', () => {
  it('refuses a plan with credentials, bad ids and bounds before querying', async () => {
    const $queryRaw = vi.fn()
    const store = new PostgresTurnAssignmentStore({ $queryRaw })
    const taskId = randomUUID()
    const siteId = randomUUID()
    const fence = { siteId, taskId, operation: 'turn' as const, epoch: 1 }
    const withKey = plan(taskId, 'session1', siteId)
    ;(withKey.context.llm as Record<string, unknown>).apiKey = 'synthetic-llm-secret'
    const base = { fence, sessionId: 'session1', turn: 1, executor: 'runner' as const }
    await expect(store.open({ ...base, plan: withKey, remainingMs: 60_000 })).rejects.toThrow()
    await expect(
      store.open({
        ...base,
        fence: { ...fence, operation: 'deploy' },
        plan: plan(taskId, 'session1', siteId),
        remainingMs: 60_000,
      } as never),
    ).rejects.toThrow()
    await expect(
      store.open({ ...base, plan: plan(taskId, 'session1', siteId), remainingMs: 21 * 60_000 }),
    ).rejects.toThrow()
    await expect(
      store.claim({ ids: ['bad'], runnerId: 'vm1', runnerSession: randomUUID(), limit: 1 }),
    ).rejects.toThrow()
    await expect(
      store.claim({ ids: [], runnerId: 'VM 1', runnerSession: randomUUID(), limit: 1 }),
    ).rejects.toThrow()
    await expect(store.advance({ id: randomUUID(), fromEpoch: 2, epoch: 2 })).rejects.toThrow()
    await expect(store.get('bad')).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
    expect(
      await store.claim({ ids: [], runnerId: 'vm1', runnerSession: randomUUID(), limit: 1 }),
    ).toEqual([])
  })
})

describe.skipIf(!databaseUrl)('PostgreSQL turn assignments', () => {
  let db: PrismaClient
  let leases: PostgresSiteLeaseStore
  let store: PostgresTurnAssignmentStore
  const workspaces: string[] = []
  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    leases = new PostgresSiteLeaseStore(db)
    store = new PostgresTurnAssignmentStore(db)
  })
  afterEach(async () => {
    for (const workspaceId of workspaces.splice(0)) {
      await db.siteLease.deleteMany({ where: { site: { workspaceId } } })
      await db.task.deleteMany({ where: { workspaceId } })
      await db.site.deleteMany({ where: { workspaceId } })
      await db.workspace.delete({ where: { id: workspaceId } })
    }
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function fixture(executor: 'local' | 'runner' = 'runner') {
    const workspace = await db.workspace.create({ data: { name: 'Synthetic assignment check' } })
    workspaces.push(workspace.id)
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Assignment test',
        url: 'https://assignment.invalid',
        stack: 'wordpress',
      },
    })
    const task = await db.task.create({ data: { workspaceId: workspace.id, siteId: site.id } })
    const lease = (await leases.acquire({
      siteId: site.id,
      taskId: task.id,
      operation: 'turn',
      ttlMs: 60_000,
    })) as SiteLeaseGrant
    const input = {
      fence: lease,
      sessionId: 'session1',
      turn: 1,
      executor,
      plan: plan(task.id, 'session1', site.id),
      remainingMs: 30_000,
    }
    return { lease, input, siteId: site.id, taskId: task.id }
  }

  it('opens only under the owned fence, with a database deadline and the plan kept', async () => {
    const { lease, input } = await fixture()
    expect(await store.open({ ...input, fence: { ...lease, epoch: lease.epoch + 1 } })).toBeNull()
    const opened = await store.open(input)
    expect(opened).toMatchObject({
      fence: { siteId: lease.siteId, taskId: lease.taskId, operation: 'turn', epoch: 1 },
      firstEpoch: 1,
      sessionId: 'session1',
      turn: 1,
      executor: 'runner',
      runner: null,
      containerId: null,
      recoveryAttempts: 0,
      outcome: null,
      plan: input.plan,
    })
    const remaining = opened!.deadlineAt.getTime() - opened!.serverNow.getTime()
    expect(remaining).toBeGreaterThan(29_000)
    expect(remaining).toBeLessThanOrEqual(30_000)
    expect(await store.get(opened!.id)).toMatchObject({ id: opened!.id, plan: input.plan })

    await leases.holdForRecovery(lease)
    expect(await store.open({ ...input, turn: 2 })).toBeNull()
  })

  it('keeps one unfinished assignment per turn between two contenders', async () => {
    const { input } = await fixture()
    const opened = await Promise.all([store.open(input), store.open(input)])
    const won = opened.filter((value) => value !== null)
    expect(won).toHaveLength(1)
    expect(await store.finish({ id: won[0]!.id, epoch: 1, outcome: 'failed' })).toBe(true)
    expect(await store.finish({ id: won[0]!.id, epoch: 1, outcome: 'completed' })).toBe(false)
    // A finished assignment no longer blocks the turn.
    const again = await store.open(input)
    expect(again?.id).not.toBe(won[0]!.id)
    expect((await store.unfinished()).filter((a) => a.fence.taskId === input.fence.taskId)).toEqual(
      [expect.objectContaining({ id: again!.id })],
    )
  })

  it('gives a runner assignment to exactly one of two claiming runners', async () => {
    const { input } = await fixture()
    const opened = (await store.open(input))!
    const sessions = [randomUUID(), randomUUID()]
    const claims = await Promise.all(
      sessions.map((runnerSession, index) =>
        store.claim({ ids: [opened.id], runnerId: `vm${index}`, runnerSession, limit: 1 }),
      ),
    )
    const winners = claims.filter((rows) => rows.length === 1)
    expect(winners).toHaveLength(1)
    const claimed = winners[0]![0]!
    expect(claimed.runner).toMatchObject({ id: expect.stringMatching(/^vm[01]$/) })
    expect(sessions).toContain(claimed.runner!.session)
    // Claimed: nobody can take it again, and a claim timeout no longer fails it.
    expect(
      await store.claim({
        ids: [opened.id],
        runnerId: 'vm9',
        runnerSession: randomUUID(),
        limit: 1,
      }),
    ).toEqual([])
    expect(await store.abandon(opened.id)).toBe(false)
  })

  it('skips an assignment another claimant holds instead of waiting for it', async () => {
    const { input } = await fixture()
    const opened = (await store.open(input))!
    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM turn_assignments WHERE id = ${opened.id}::uuid FOR UPDATE`
      const started = performance.now()
      expect(
        await store.claim({
          ids: [opened.id],
          runnerId: 'vm1',
          runnerSession: randomUUID(),
          limit: 1,
        }),
      ).toEqual([])
      expect(performance.now() - started).toBeLessThan(2_000)
    })
    expect(
      await store.claim({
        ids: [opened.id],
        runnerId: 'vm1',
        runnerSession: randomUUID(),
        limit: 1,
      }),
    ).toHaveLength(1)
  })

  it('abandons an unclaimed runner assignment and never claims a local one', async () => {
    const runner = await fixture()
    const unclaimed = (await store.open(runner.input))!
    expect(await store.abandon(unclaimed.id)).toBe(true)
    expect(await store.get(unclaimed.id)).toMatchObject({ outcome: 'failed' })
    expect(
      await store.claim({
        ids: [unclaimed.id],
        runnerId: 'vm1',
        runnerSession: randomUUID(),
        limit: 1,
      }),
    ).toEqual([])

    const local = await fixture('local')
    const own = (await store.open(local.input))!
    expect(
      await store.claim({ ids: [own.id], runnerId: 'vm1', runnerSession: randomUUID(), limit: 1 }),
    ).toEqual([])
    expect(await store.abandon(own.id)).toBe(false)
  })

  it('records one container and advances only under the reclaimed newer epoch', async () => {
    const { lease, input } = await fixture()
    const opened = (await store.open(input))!
    const session = randomUUID()
    await store.claim({ ids: [opened.id], runnerId: 'vm1', runnerSession: session, limit: 1 })
    expect(await store.recordContainer({ id: opened.id, epoch: 2, containerId: 'c1' })).toBe(false)
    expect(await store.recordContainer({ id: opened.id, epoch: 1, containerId: 'c1' })).toBe(true)
    expect(await store.recordContainer({ id: opened.id, epoch: 1, containerId: 'c1' })).toBe(true)
    expect(await store.recordContainer({ id: opened.id, epoch: 1, containerId: 'c2' })).toBe(false)
    await store.seen({ runnerId: 'vm1', runnerSession: session, ids: [opened.id] })

    // The newer epoch must own the lease first.
    expect(await store.advance({ id: opened.id, fromEpoch: 1, epoch: 2 })).toBeNull()
    await leases.holdForRecovery(lease)
    const reclaimed = (await leases.reclaimForRecovery(lease, 60_000))!
    expect(reclaimed.epoch).toBe(2)
    const restarted = randomUUID()
    const advanced = await store.advance({
      id: opened.id,
      fromEpoch: 1,
      epoch: 2,
      runnerSession: restarted,
    })
    expect(advanced).toMatchObject({
      fence: { epoch: 2 },
      firstEpoch: 1,
      recoveryAttempts: 1,
      containerId: 'c1',
      runner: { id: 'vm1', session: restarted },
    })
    expect(await store.advance({ id: opened.id, fromEpoch: 1, epoch: 2 })).toBeNull()
    expect(await store.finish({ id: opened.id, epoch: 1, outcome: 'lost' })).toBe(false)
    expect((await store.unfinished({ runnerId: 'vm1' })).map((a) => a.id)).toContain(opened.id)
    expect(await store.finish({ id: opened.id, epoch: 2, outcome: 'lost' })).toBe(true)
    expect((await store.unfinished({ runnerId: 'vm1' })).map((a) => a.id)).not.toContain(opened.id)
  })

  it('lets exactly one of a claim and an abandon win an unclaimed assignment', async () => {
    const claimFirst = await fixture()
    const claimed = (await store.open(claimFirst.input))!
    let abandoning: Promise<boolean> | undefined
    let answered = false
    // A runner's claim holds the row while the core that waited for it gives the turn up.
    await db.$transaction(async (tx) => {
      const rows = await new PostgresTurnAssignmentStore(tx).claim({
        ids: [claimed.id],
        runnerId: 'vm1',
        runnerSession: randomUUID(),
        limit: 1,
      })
      expect(rows).toHaveLength(1)
      abandoning = store.abandon(claimed.id)
      void abandoning.finally(() => {
        answered = true
      })
      await new Promise((resolve) => setTimeout(resolve, 300))
      // The abandon waits for the claim instead of failing a turn a runner may be preparing.
      expect(answered).toBe(false)
    })
    expect(await abandoning).toBe(false)
    expect(await store.get(claimed.id)).toMatchObject({ outcome: null, runner: { id: 'vm1' } })

    const abandonFirst = await fixture()
    const abandoned = (await store.open(abandonFirst.input))!
    const claim = () =>
      store.claim({ ids: [abandoned.id], runnerId: 'vm1', runnerSession: randomUUID(), limit: 1 })
    await db.$transaction(async (tx) => {
      expect(await new PostgresTurnAssignmentStore(tx).abandon(abandoned.id)).toBe(true)
      // Skipped while the abandon holds it, and never claimed once it committed.
      expect(await claim()).toEqual([])
    })
    expect(await claim()).toEqual([])
    expect(await store.get(abandoned.id)).toMatchObject({ outcome: 'failed', runner: null })
  })

  it('counts a recovery attempt only when asked, under the current epoch', async () => {
    const { lease, input } = await fixture()
    const opened = (await store.open(input))!
    await leases.holdForRecovery(lease)
    expect((await leases.reclaimForRecovery(lease, 60_000))!.epoch).toBe(2)
    expect(
      await store.advance({ id: opened.id, fromEpoch: 1, epoch: 2, countAttempt: false }),
    ).toMatchObject({ fence: { epoch: 2 }, recoveryAttempts: 0 })
    expect(await store.countAttempt({ id: opened.id, epoch: 1 })).toBe(false)
    expect(await store.countAttempt({ id: opened.id, epoch: 2 })).toBe(true)
    expect(await store.get(opened.id)).toMatchObject({ recoveryAttempts: 1 })
    expect(await store.finish({ id: opened.id, epoch: 2, outcome: 'completed' })).toBe(true)
    expect(await store.countAttempt({ id: opened.id, epoch: 2 })).toBe(false)
    expect(await store.get(opened.id)).toMatchObject({ recoveryAttempts: 1 })
  })

  it('refuses runner fields on a local assignment in the database itself', async () => {
    const { input } = await fixture('local')
    const opened = (await store.open(input))!
    await expect(
      db.$executeRaw`UPDATE turn_assignments SET runner_id = 'vm1', runner_session = ${randomUUID()}::uuid,
        claimed_at = now() WHERE id = ${opened.id}::uuid`,
    ).rejects.toThrow()
  })
})
