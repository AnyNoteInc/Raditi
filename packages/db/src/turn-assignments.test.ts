import { randomUUID } from 'node:crypto'

import { runnerLimits, type SiteLeaseGrant, type TurnPlan } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { createPrismaClient } from './client.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { PostgresSiteLeaseStore } from './site-leases.ts'
import { PostgresTurnAssignmentStore, UNFINISHED_PAGE } from './turn-assignments.ts'

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
    // The hub offers at most this many waiting turns per claim (RunnerHub).
    const waiting = (count: number) => Array.from({ length: count }, () => randomUUID())
    await expect(
      store.claim({
        ids: waiting(runnerLimits.claimIds + 1),
        runnerId: 'vm1',
        runnerSession: randomUUID(),
        limit: 1,
      }),
    ).rejects.toThrow()
    await expect(
      store.takeOver({
        id: randomUUID(),
        fence: { ...fence, operation: 'deploy' } as never,
        ttlMs: 60_000,
      }),
    ).rejects.toThrow()
    await expect(store.takeOver({ id: randomUUID(), fence, ttlMs: 999 })).rejects.toThrow()
    await expect(store.get('bad')).rejects.toThrow()
    expect($queryRaw).not.toHaveBeenCalled()
    expect(
      await store.claim({ ids: [], runnerId: 'vm1', runnerSession: randomUUID(), limit: 1 }),
    ).toEqual([])
    $queryRaw.mockResolvedValue([])
    expect(
      await store.claim({
        ids: waiting(runnerLimits.claimIds),
        runnerId: 'vm1',
        runnerSession: randomUUID(),
        limit: 1,
      }),
    ).toEqual([])
    expect($queryRaw).toHaveBeenCalledOnce()
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

    // Recovery gives up a turn its dead core left unclaimed: lost, not failed.
    const orphaned = (await store.open((await fixture()).input))!
    expect(await store.abandon(orphaned.id, 'lost')).toBe(true)
    expect(await store.get(orphaned.id)).toMatchObject({ outcome: 'lost' })
    expect(await store.abandon(orphaned.id, 'failed')).toBe(false)
    expect(await store.get(orphaned.id)).toMatchObject({ outcome: 'lost' })
  })

  it('records one container and takes the turn over only from the lease held at its epoch', async () => {
    const { lease, input } = await fixture()
    const opened = (await store.open(input))!
    const session = randomUUID()
    await store.claim({ ids: [opened.id], runnerId: 'vm1', runnerSession: session, limit: 1 })
    expect(await store.recordContainer({ id: opened.id, epoch: 2, containerId: 'c1' })).toBe(false)
    expect(await store.recordContainer({ id: opened.id, epoch: 1, containerId: 'c1' })).toBe(true)
    expect(await store.recordContainer({ id: opened.id, epoch: 1, containerId: 'c1' })).toBe(true)
    expect(await store.recordContainer({ id: opened.id, epoch: 1, containerId: 'c2' })).toBe(false)

    // The lease must be held for recovery at the assignment's epoch first.
    expect(await store.takeOver({ id: opened.id, fence: lease, ttlMs: 60_000 })).toBeNull()
    expect(await leases.inspect(lease.siteId)).toMatchObject({ epoch: 1, heldForOperator: false })
    await leases.holdForRecovery(lease)
    const restarted = randomUUID()
    const taken = (await store.takeOver({
      id: opened.id,
      fence: lease,
      ttlMs: 60_000,
      runnerSession: restarted,
    }))!
    expect(taken.assignment).toMatchObject({
      fence: { epoch: 2 },
      firstEpoch: 1,
      recoveryAttempts: 1,
      containerId: 'c1',
      runner: { id: 'vm1', session: restarted },
    })
    expect(taken.grant).toMatchObject({
      siteId: lease.siteId,
      taskId: lease.taskId,
      operation: 'turn',
      epoch: 2,
    })
    const ttl = taken.grant.expiresAt.getTime() - taken.grant.serverNow.getTime()
    expect(ttl).toBeGreaterThan(59_000)
    expect(ttl).toBeLessThanOrEqual(60_000)
    expect(await leases.assert(taken.grant)).toBe(true)
    expect(await store.takeOver({ id: opened.id, fence: lease, ttlMs: 60_000 })).toBeNull()
    expect(await store.finish({ id: opened.id, epoch: 1, outcome: 'lost' })).toBe(false)
    expect((await store.unfinished({ runnerId: 'vm1' })).map((a) => a.id)).toContain(opened.id)
    expect(await store.finish({ id: opened.id, epoch: 2, outcome: 'lost' })).toBe(true)
    expect((await store.unfinished({ runnerId: 'vm1' })).map((a) => a.id)).not.toContain(opened.id)
  })

  it('moves neither the lease nor the assignment when either one refuses the takeover', async () => {
    const { lease, input } = await fixture()
    const opened = (await store.open(input))!
    await leases.holdForRecovery(lease)
    const held = { epoch: 1, heldForOperator: true, taskId: lease.taskId }
    // A new runner session only for a claimed assignment.
    expect(
      await store.takeOver({
        id: opened.id,
        fence: lease,
        ttlMs: 60_000,
        runnerSession: randomUUID(),
      }),
    ).toBeNull()
    // Another task's fence, or the lease of another epoch.
    expect(
      await store.takeOver({
        id: opened.id,
        fence: { ...lease, taskId: randomUUID() },
        ttlMs: 60_000,
      }),
    ).toBeNull()
    expect(
      await store.takeOver({ id: opened.id, fence: { ...lease, epoch: 2 }, ttlMs: 60_000 }),
    ).toBeNull()
    expect(await leases.inspect(lease.siteId)).toMatchObject(held)
    expect(await store.get(opened.id)).toMatchObject({ fence: { epoch: 1 }, recoveryAttempts: 0 })

    // Finished by its owner: the held lease stays at its epoch for recovery to free.
    expect(await store.finish({ id: opened.id, epoch: 1, outcome: 'failed' })).toBe(true)
    expect(await store.takeOver({ id: opened.id, fence: lease, ttlMs: 60_000 })).toBeNull()
    expect(await leases.inspect(lease.siteId)).toMatchObject(held)
  })

  it('lets exactly one of two takeovers of the same held epoch win', async () => {
    const { lease, input } = await fixture()
    const opened = (await store.open(input))!
    await leases.holdForRecovery(lease)
    const results = await Promise.all(
      [1, 2].map(() => store.takeOver({ id: opened.id, fence: lease, ttlMs: 60_000 })),
    )
    expect(results.filter((taken) => taken !== null)).toHaveLength(1)
    expect(await leases.inspect(lease.siteId)).toMatchObject({ epoch: 2, heldForOperator: false })
    expect(await store.get(opened.id)).toMatchObject({ fence: { epoch: 2 }, recoveryAttempts: 1 })
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
    expect(
      (await store.takeOver({ id: opened.id, fence: lease, ttlMs: 60_000, countAttempt: false }))
        ?.assignment,
    ).toMatchObject({ fence: { epoch: 2 }, recoveryAttempts: 0 })
    expect(await store.countAttempt({ id: opened.id, epoch: 1 })).toBe(false)
    expect(await store.countAttempt({ id: opened.id, epoch: 2 })).toBe(true)
    expect(await store.get(opened.id)).toMatchObject({ recoveryAttempts: 1 })
    expect(await store.finish({ id: opened.id, epoch: 2, outcome: 'completed' })).toBe(true)
    expect(await store.countAttempt({ id: opened.id, epoch: 2 })).toBe(false)
    expect(await store.get(opened.id)).toMatchObject({ recoveryAttempts: 1 })
  })

  it('frees only holds left on the epoch of a finished assignment of the holding task', async () => {
    const hold = async (finished: boolean) => {
      const { lease, input, siteId } = await fixture()
      const opened = (await store.open(input))!
      await leases.holdForRecovery(lease)
      if (finished) await store.finish({ id: opened.id, epoch: lease.epoch, outcome: 'failed' })
      return { lease, siteId }
    }
    const orphan = await hold(true)
    const open = await hold(false)
    // Finished and released: nothing is held.
    const released = await fixture()
    const done = (await store.open(released.input))!
    await store.finish({ id: done.id, epoch: released.lease.epoch, outcome: 'completed' })
    await leases.release(released.lease)
    // Held again under a newer epoch that no finished assignment names.
    const again = (await leases.acquire({
      siteId: released.siteId,
      taskId: released.taskId,
      operation: 'turn',
      ttlMs: 60_000,
    }))!
    await leases.holdForRecovery(again)

    expect(await store.freeOrphanedHolds()).toBeGreaterThanOrEqual(1)
    expect(await leases.inspect(orphan.siteId)).toMatchObject({
      taskId: null,
      heldForOperator: false,
      epoch: orphan.lease.epoch,
    })
    expect(await leases.inspect(open.siteId)).toMatchObject({
      taskId: open.lease.taskId,
      heldForOperator: true,
    })
    expect(await leases.inspect(released.siteId)).toMatchObject({
      taskId: released.taskId,
      heldForOperator: true,
      epoch: again.epoch,
    })
    expect(await leases.holdForRecovery(orphan.lease)).toBe(false)
  })

  it('returns every unfinished assignment, however many older ones are left open', async () => {
    const { input } = await fixture()
    const newest = (await store.open(input))!
    const runnerId = `vm-${randomUUID().slice(0, 8)}`
    await store.claim({ ids: [newest.id], runnerId, runnerSession: randomUUID(), limit: 1 })
    // Older turns of the task nobody closes, as turns parked for an operator; ties on created_at
    // are ordered by id.
    await db.$executeRaw`
      INSERT INTO turn_assignments (id, task_id, site_id, session_id, turn_no, executor, plan,
        first_epoch, lease_epoch, deadline_at, runner_id, runner_session, claimed_at, created_at,
        updated_at)
      SELECT gen_random_uuid(), a.task_id, a.site_id, a.session_id, a.turn_no + n, a.executor,
        a.plan, a.first_epoch, a.lease_epoch, a.deadline_at, a.runner_id, a.runner_session,
        a.claimed_at, a.created_at - make_interval(secs => 1 + n % 7), clock_timestamp()
      FROM turn_assignments a, generate_series(1, ${UNFINISHED_PAGE}) n
      WHERE a.id = ${newest.id}::uuid`
    for (const filter of [{}, { runnerId }]) {
      const ids = (await store.unfinished(filter))
        .filter((a) => a.fence.taskId === input.fence.taskId)
        .map((a) => a.id)
      expect(ids).toHaveLength(UNFINISHED_PAGE + 1)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.at(-1)).toBe(newest.id)
    }
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
