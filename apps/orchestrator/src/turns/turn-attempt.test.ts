import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import {
  conflict,
  coreStopping,
  leaseLost,
  MAX_SANDBOX_TURN_MS,
  runnerReportSchema,
  runnerUnavailable,
  SANDBOX_SECRETS_DIR,
  toTurnPlan,
  TURN_PUBLICATION_GRACE_MS,
  type TurnExecution,
  type TurnRequest,
} from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RemoteTurnExecutor } from '../runner-api/remote-turn-executor.ts'
import { RunnerHub } from '../runner-api/runner-hub.ts'
import { sampleDriverId } from '../testing/ids.ts'
import { MemorySiteLeases } from '../testing/site-leases.ts'
import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { MemoryTurnCredentials } from '../testing/turn-credentials.ts'
import { MemoryTurnJournal } from '../testing/turn-journal.ts'
import { LeaseGuard } from './lease-guard.ts'
import { TurnAttempt } from './turn-attempt.ts'

const labels = {
  workspaceId: '00000000-0000-4000-8000-000000000001',
  siteId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
  sessionId: 'session1',
  turn: 1,
}

const request: TurnRequest = {
  sandbox: {
    image: `registry.invalid/raditi/${sampleDriverId}@sha256:${'a'.repeat(64)}`,
    labels,
    runtime: 'runc',
    resources: { cpu: 1, memoryMiB: 256, pids: 64 },
    user: { uid: 10001, gid: 10001 },
    env: {},
    secrets: [],
    network: { mode: 'none' },
    hardTimeoutMs: MAX_SANDBOX_TURN_MS,
  },
  context: {
    taskId: labels.taskId,
    sessionId: labels.sessionId,
    turn: 1,
    llm: { baseUrl: 'http://synthetic.invalid', apiKey: 'synthetic-llm-secret', model: 'm' },
    mcp: { url: 'http://synthetic.invalid/mcp', token: 'synthetic-mcp-secret' },
    instructions: 'Synthetic verification',
  },
  input: { prompt: 'Synthetic turn', attachments: [] },
  driverVersion: '1.0.0',
  workspace: {
    repo: { provider: 'gitea', owner: 'sites', name: 'synthetic' },
    branch: `agent/${labels.taskId}`,
    expectedBaseSha: 'b'.repeat(40),
    protectedPaths: [],
  },
  committedAt: '2026-09-27T00:00:00.000Z',
}

const guards: LeaseGuard[] = []
const hubs: RunnerHub[] = []
afterEach(() => {
  for (const guard of guards.splice(0)) guard.close()
  for (const hub of hubs.splice(0)) hub.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** A supervisor's attempt on a leased site with an open assignment; the turn is cancelled. */
async function given() {
  const leases = new MemorySiteLeases()
  const journal = new MemoryTurnJournal(leases)
  const assignments = new MemoryTurnAssignments(leases)
  const credentials = new MemoryTurnCredentials()
  const revoke = vi.spyOn(credentials, 'revoke')
  const logger = { warn: vi.fn() }
  const lease = (await leases.acquire({
    siteId: labels.siteId,
    taskId: labels.taskId,
    operation: 'turn',
    ttlMs: MAX_SANDBOX_TURN_MS + TURN_PUBLICATION_GRACE_MS,
  }))!
  const cancel = new AbortController()
  const guard = new LeaseGuard(lease, leases, MAX_SANDBOX_TURN_MS, cancel.signal)
  guards.push(guard)
  const plan = toTurnPlan(request, sampleDriverId)
  const attempt = new TurnAttempt(
    {
      leases,
      assignments,
      journal,
      credentials,
      logger,
      workspace: {} as never,
      snapshots: {} as never,
    },
    { lease, guard, plan },
  )
  await attempt.record('leased')
  attempt.assignment = (await assignments.open({
    fence: lease,
    sessionId: labels.sessionId,
    turn: 1,
    executor: 'runner',
    plan,
    remainingMs: MAX_SANDBOX_TURN_MS,
  }))!
  attempt.credentialRef = {
    taskId: labels.taskId,
    sessionId: labels.sessionId,
    turn: labels.turn,
    epoch: attempt.assignment.firstEpoch,
  }
  const destroy = vi.fn(async () => {})
  const execution = { containerId: 'container1', destroy } as unknown as TurnExecution
  const release = vi.spyOn(leases, 'release')
  const finish = vi.spyOn(assignments, 'finish')
  return {
    leases,
    journal,
    assignments,
    lease,
    guard,
    plan,
    attempt,
    execution,
    destroy,
    release,
    finish,
    credentials,
    revoke,
    logger,
    cancel: () => cancel.abort(),
    row: () => leases.rows.get(labels.siteId)!,
    outcome: () => [...assignments.rows.values()][0]!.outcome,
  }
}

describe('TurnAttempt given up while its prepare was out (spec §8)', () => {
  it('removes a container reported before settle like any other: failed and one release', async () => {
    const t = await given()
    t.attempt.dispatched()
    t.cancel()
    // Reported after the cancellation but before settle: the attempt owns it now.
    await expect(t.attempt.created(t.execution)).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
    })
    t.attempt.failed(new Error('cancelled'))
    expect(await t.attempt.settle()).toBe('released')
    expect(t.destroy).toHaveBeenCalledExactlyOnceWith('cancelled')
    expect(t.release).toHaveBeenCalledOnce()
    expect(t.journal.phases()).toEqual(['leased', 'failed'])
    expect(t.outcome()).toBe('failed')
    expect(t.row()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })

  it('journals a late container after the vacating entry, then frees the site once it is removed', async () => {
    const t = await given()
    t.attempt.dispatched()
    t.cancel()
    t.attempt.failed(new Error('cancelled'))
    // The vacating entry is slow to commit while the late container is reported.
    const record = t.journal.record.bind(t.journal)
    const slow = Promise.withResolvers<void>()
    vi.spyOn(t.journal, 'record').mockImplementation(async (entry) => {
      if (entry.phase === 'vacating' && entry.containerId === undefined) await slow.promise
      return record(entry)
    })
    let settled = false
    const settling = t.attempt.settle().finally(() => {
      settled = true
    })
    const late = t.attempt.created(t.execution)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(t.journal.phases()).toEqual(['leased'])
    // The supervisor leaves LiveTurns only once the entry is journaled.
    expect(settled).toBe(false)
    expect(t.release).not.toHaveBeenCalled()
    expect(t.revoke).not.toHaveBeenCalled()
    slow.resolve()
    expect(await settling).toBe('vacating')
    await expect(late).rejects.toMatchObject({ code: 'TURN_INTERRUPTED' })

    expect(t.journal.entries.slice(1)).toMatchObject([
      { phase: 'vacating', reason: 'cancelled' },
      { phase: 'vacating', reason: 'cancelled', containerId: 'container1' },
      { phase: 'failed', reason: 'cancelled' },
    ])
    expect(t.journal.entries[1]).not.toHaveProperty('containerId')
    expect(t.destroy).toHaveBeenCalledExactlyOnceWith('cancelled')
    expect(t.release).toHaveBeenCalledOnce()
    expect(t.finish).toHaveBeenCalledOnce()
    expect(t.outcome()).toBe('failed')
    expect(t.row()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })

  it('frees the site once, whether the proof comes before settle or again after it', async () => {
    const before = await given()
    before.attempt.dispatched()
    before.attempt.vacated()
    expect(await before.attempt.settle()).toBe('released')
    before.attempt.vacated()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(before.release).toHaveBeenCalledOnce()
    expect(before.finish).toHaveBeenCalledOnce()
    expect(before.journal.phases()).toEqual(['leased', 'failed'])

    const after = await given()
    after.attempt.dispatched()
    expect(await after.attempt.settle()).toBe('vacating')
    after.attempt.vacated()
    after.attempt.vacated()
    await vi.waitFor(() => expect(after.outcome()).toBe('failed'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(after.release).toHaveBeenCalledOnce()
    expect(after.finish).toHaveBeenCalledOnce()
    expect(after.journal.phases()).toEqual(['leased', 'vacating', 'failed'])
  })

  it('writes the vacating entry again while the database refuses it, before it lets go', async () => {
    const t = await given()
    t.attempt.dispatched()
    const record = t.journal.record.bind(t.journal)
    let refused = 0
    vi.spyOn(t.journal, 'record').mockImplementation(async (entry) => {
      if (entry.phase === 'vacating' && refused++ === 0) throw new Error('database unavailable')
      return record(entry)
    })
    expect(await t.attempt.settle()).toBe('vacating')
    expect(t.journal.phases()).toEqual(['leased', 'vacating'])
    t.attempt.vacated()
    await vi.waitFor(() => expect(t.outcome()).toBe('failed'))
    expect(t.journal.phases()).toEqual(['leased', 'vacating', 'failed'])
    expect(t.release).toHaveBeenCalledOnce()
    expect(t.row()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })

  it('stops writing the vacating entry once another owner has the site', async () => {
    const t = await given()
    t.attempt.dispatched()
    const record = vi.spyOn(t.journal, 'record')
    // Recovery took the turn over meanwhile: the journal refuses this epoch for good.
    await t.leases.holdForRecovery(t.lease)
    await t.assignments.takeOver({
      id: t.attempt.assignment!.id,
      fence: t.lease,
      ttlMs: 60_000,
      countAttempt: false,
    })
    expect(await t.attempt.settle()).toBe('vacating')
    expect(record.mock.calls.filter(([entry]) => entry.phase === 'vacating')).toHaveLength(1)
    expect(t.journal.phases()).toEqual(['leased'])
  })

  it('leaves the assignment to recovery once it holds the site at the turn’s epoch', async () => {
    const t = await given()
    t.attempt.dispatched()
    expect(await t.attempt.settle()).toBe('vacating')
    // Recovery held the site to take the turn over; the proof arrives in that window.
    expect(await t.leases.holdForRecovery(t.lease)).toBe(true)
    t.attempt.vacated()
    await vi.waitFor(() => expect(t.journal.phases().at(-1)).toBe('failed'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(t.finish).not.toHaveBeenCalled()
    expect(t.revoke).toHaveBeenCalledOnce()
    expect(t.row()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })
    // So its takeover is never lost to this attempt's finish.
    expect(
      (
        await t.assignments.takeOver({
          id: t.attempt.assignment!.id,
          fence: t.lease,
          ttlMs: 60_000,
          countAttempt: false,
        })
      )?.assignment,
    ).toMatchObject({ fence: { epoch: 2 }, recoveryAttempts: 0 })
  })

  it('holds the site when a late container cannot be removed, and a later proof changes nothing', async () => {
    const t = await given()
    t.attempt.dispatched()
    expect(await t.attempt.settle()).toBe('vacating')
    t.destroy.mockRejectedValue(new Error('unreachable daemon'))
    await expect(t.attempt.created(t.execution)).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
    })
    expect(t.journal.entries.at(-1)).toMatchObject({
      phase: 'recovery',
      reason: 'destroy_failed',
      containerId: 'container1',
    })
    expect(t.row()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })
    t.attempt.vacated()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(t.release).not.toHaveBeenCalled()
    expect(t.finish).not.toHaveBeenCalled()
    expect(t.journal.phases().at(-1)).toBe('recovery')
  })

  it('leaves a late container to recovery that took the turn over under a newer epoch', async () => {
    const t = await given()
    t.attempt.dispatched()
    expect(await t.attempt.settle()).toBe('vacating')
    await t.leases.holdForRecovery(t.lease)
    await t.assignments.takeOver({
      id: t.attempt.assignment!.id,
      fence: t.lease,
      ttlMs: 60_000,
      countAttempt: false,
    })
    // The executor refuses the older owner's removal: the turn is recovery's now.
    t.destroy.mockRejectedValue(new Error('The turn was taken over under a newer fence'))
    await expect(t.attempt.created(t.execution)).rejects.toMatchObject({
      code: 'TURN_INTERRUPTED',
    })
    expect(t.row()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 2 })
    expect(t.release).not.toHaveBeenCalled()
    expect(t.finish).not.toHaveBeenCalled()
    expect(t.journal.phases().at(-1)).toBe('vacating')
  })
})

describe('TurnAttempt when core stops (spec §8 «Устройство раннера»)', () => {
  it('leaves a running turn to the next core: no removal, hold or journal entry', async () => {
    const t = await given()
    await t.attempt.created(t.execution)
    t.destroy.mockRejectedValue(coreStopping())
    t.attempt.failed(coreStopping())
    expect(await t.attempt.settle()).toBe('held')
    expect(t.journal.phases()).toEqual(['leased', 'created'])
    expect(t.row()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 1 })
    expect(t.release).not.toHaveBeenCalled()
    expect(t.finish).not.toHaveBeenCalled()
    expect(t.revoke).not.toHaveBeenCalled()
    expect(t.outcome()).toBeNull()
  })

  it('still holds the site when a runner does not answer the removal', async () => {
    const t = await given()
    await t.attempt.created(t.execution)
    t.destroy.mockRejectedValue(runnerUnavailable('The sandbox runner did not answer in time'))
    t.attempt.failed(new Error('agent failed'))
    expect(await t.attempt.settle()).toBe('held')
    expect(t.journal.entries.at(-1)).toMatchObject({ phase: 'recovery', reason: 'destroy_failed' })
    expect(t.row()).toMatchObject({ taskId: labels.taskId, held: true, epoch: 1 })
    expect(t.finish).not.toHaveBeenCalled()
    expect(t.revoke).toHaveBeenCalledOnce()
  })
})

describe('TurnAttempt credential cleanup', () => {
  it('revokes after removal and before releasing the site', async () => {
    const t = await given()
    await t.attempt.created(t.execution)
    t.revoke.mockImplementation(async () => {
      expect(t.destroy).toHaveBeenCalledOnce()
      expect(t.release).not.toHaveBeenCalled()
      expect(t.row().taskId).toBe(labels.taskId)
    })
    expect(await t.attempt.settle()).toBe('released')
    expect(t.revoke).toHaveBeenCalledExactlyOnceWith(t.attempt.credentialRef)
    expect(t.release).toHaveBeenCalledOnce()
  })

  it('revokes a vacating turn before leaving it to recovery', async () => {
    const t = await given()
    t.attempt.dispatched()
    expect(await t.attempt.settle()).toBe('vacating')
    expect(t.revoke).toHaveBeenCalledOnce()
    expect(t.release).not.toHaveBeenCalled()
    t.attempt.vacated()
    await vi.waitFor(() => expect(t.release).toHaveBeenCalledOnce())
    expect(t.revoke).toHaveBeenCalledOnce()
  })

  it.each([
    ['its executor refuses the stale removal', true],
    ['its own removal still goes through', false],
  ])(
    'leaves the credentials to the owner that took the turn over under a newer epoch, when %s',
    async (_, refused) => {
      const t = await given()
      await t.attempt.created(t.execution)
      // Another core's recovery took the running turn over and resumed its agent with these keys.
      await t.leases.holdForRecovery(t.lease)
      await t.assignments.takeOver({ id: t.attempt.assignment!.id, fence: t.lease, ttlMs: 60_000 })
      if (refused)
        t.destroy.mockRejectedValue(conflict('The turn was taken over under a newer fence'))
      // The stale owner finds its lease gone and settles.
      t.attempt.failed(leaseLost())
      await t.attempt.settle()
      expect(t.revoke).not.toHaveBeenCalled()
      // Everything else it tries is fenced by its epoch: the turn stays the new owner's.
      expect(t.row()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 2 })
      expect(t.outcome()).toBeNull()
      expect(t.journal.phases()).toEqual(['leased', 'created'])
    },
  )

  it('revokes the credentials of a turn whose site another task has by now', async () => {
    const t = await given()
    await t.attempt.created(t.execution)
    // The lease ran out and another task took the site: nobody continues this turn.
    t.row().expiresAt = Date.now() - 1
    expect(
      await t.leases.acquire({
        siteId: labels.siteId,
        taskId: '00000000-0000-4000-8000-000000000009',
        operation: 'turn',
        ttlMs: 60_000,
      }),
    ).toMatchObject({ epoch: 2 })
    t.attempt.failed(leaseLost())
    await t.attempt.settle()
    expect(t.revoke).toHaveBeenCalledExactlyOnceWith(t.attempt.credentialRef)
  })

  it('releases the site after a rejected revoke and logs no storage error text', async () => {
    const t = await given()
    t.revoke.mockRejectedValue(new Error('secret-token-in-vault-response'))
    expect(await t.attempt.settle()).toBe('released')
    expect(t.release).toHaveBeenCalledOnce()
    expect(t.logger.warn).toHaveBeenCalledExactlyOnceWith('llm_turn_credentials_revoke_failed')
  })

  it('releases the site after five seconds when Vault never answers', async () => {
    const t = await given()
    vi.useFakeTimers()
    t.revoke.mockImplementation(() => new Promise(() => {}))
    const settling = t.attempt.settle()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(t.release).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await settling).toBe('released')
    expect(t.release).toHaveBeenCalledOnce()
    expect(t.logger.warn).toHaveBeenCalledExactlyOnceWith('llm_turn_credentials_revoke_failed')
  })
})

/**
 * The supervisor's prepare on a runner, driven by hand: `poll` is one long poll of the runner,
 * `settled` what the attempt did once the prepare failed or the turn was given up.
 */
async function onRunner() {
  const t = await given()
  const hub = new RunnerHub({
    assignments: t.assignments,
    leases: t.leases,
    logger: { warn: vi.fn() },
  })
  hubs.push(hub)
  const executor = new RemoteTurnExecutor(hub, t.leases, t.assignments)
  const runnerSession = randomUUID()
  const bundleBytes = Buffer.from('synthetic bundle')
  const poll = async () =>
    (
      await hub.poll(
        'sandbox-1',
        { runnerSession, capacity: 1, inventory: [], active: [] },
        AbortSignal.timeout(200),
      )
    ).commands
  const report = (body: Record<string, unknown>) =>
    hub.report(
      'sandbox-1',
      runnerReportSchema.parse({
        runnerSession,
        assignmentId: t.attempt.assignment!.id,
        epoch: 1,
        ...body,
      }),
    )
  const dispatched = vi.spyOn(t.attempt, 'dispatched')
  const preparing = executor.prepare(
    {
      assignmentId: t.attempt.assignment!.id,
      fence: t.lease,
      sandbox: { ...request.sandbox, labels: { ...labels, leaseEpoch: 1 } },
      remainingMs: t.guard.remainingMs,
      bundle: {
        baseSha: request.workspace.expectedBaseSha,
        branch: request.workspace.branch,
        sha256: createHash('sha256').update(bundleBytes).digest('hex'),
        sizeBytes: bundleBytes.byteLength,
        read: async function* () {
          yield Buffer.from(bundleBytes)
        },
      },
      driverId: sampleDriverId,
      prepared: {
        files: [],
        env: {},
        secrets: [{ path: `${SANDBOX_SECRETS_DIR}/llm`, content: 'synthetic-llm-secret' }],
      },
      argv: ['synthetic-agent'],
      credentials: ['synthetic-llm-secret'],
      created: (execution) => t.attempt.created(execution),
      dispatched: () => t.attempt.dispatched(),
      vacated: () => t.attempt.vacated(),
    },
    t.guard.signal,
  )
  preparing.catch(() => {})
  const settled = t.guard.interruptible(preparing).then(
    () => 'prepared' as const,
    (error: unknown) => {
      t.attempt.failed(error)
      return t.attempt.settle()
    },
  )
  return { ...t, hub, runnerSession, poll, report, dispatched, preparing, settled }
}

describe('TurnAttempt over a runner: delivery against giving up (spec §8)', () => {
  it('frees the site at once when the turn is given up before any poll took the prepare', async () => {
    const t = await onRunner()
    t.cancel()
    expect(await t.settled).toBe('released')
    expect(await t.poll()).toEqual([])
    expect(t.dispatched).not.toHaveBeenCalled()
    expect(t.row()).toMatchObject({ taskId: null, held: false, epoch: 1 })
    expect(t.outcome()).toBe('failed')
  })

  it('vacates when a poll took the prepare in the same tick as the owner gave up', async () => {
    const t = await onRunner()
    const [prepare] = await t.poll()
    expect(prepare).toMatchObject({ type: 'prepare' })
    t.cancel()
    expect(await t.settled).toBe('vacating')
    expect(t.dispatched).toHaveBeenCalledOnce()
    expect(t.release).not.toHaveBeenCalled()
    expect(t.row()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 1 })
    expect(t.journal.phases()).toEqual(['leased', 'vacating'])

    // The runner answers that it created nothing (P3): the site is freed now.
    await t.report({
      type: 'failed',
      commandId: prepare!.commandId,
      code: 'SANDBOX_COMMAND_FAILED',
      absent: true,
    })
    await vi.waitFor(() => expect(t.outcome()).toBe('failed'))
    expect(t.release).toHaveBeenCalledOnce()
    expect(t.row()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })

  it('never hands out again a prepare whose poll answer was lost, and still vacates', async () => {
    const t = await onRunner()
    const [prepare] = await t.poll()
    // The answer never reached the runner: the hub puts it back, then the owner gives up.
    t.hub.requeue('sandbox-1', t.runnerSession, [prepare!])
    t.cancel()
    expect(await t.settled).toBe('vacating')
    expect(await t.poll()).toEqual([])
    expect(t.dispatched).toHaveBeenCalledOnce()
    expect(t.release).not.toHaveBeenCalled()
  })

  it('frees the site at once when its turn ran out before a poll took the prepare', async () => {
    const t = await onRunner()
    const now = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => now() + MAX_SANDBOX_TURN_MS + 1_000)
    expect(await t.poll()).toEqual([])
    expect(await t.settled).toBe('released')
    expect(t.dispatched).not.toHaveBeenCalled()
    expect(t.row()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })

  it('still vacates when only the second delivery of a prepare is refused as too late', async () => {
    const t = await onRunner()
    const [prepare] = await t.poll()
    t.hub.requeue('sandbox-1', t.runnerSession, [prepare!])
    const now = performance.now.bind(performance)
    vi.spyOn(performance, 'now').mockImplementation(() => now() + MAX_SANDBOX_TURN_MS + 1_000)
    expect(await t.poll()).toEqual([])
    // The first delivery went out: a container may exist, so nothing is freed early.
    expect(await t.settled).toBe('vacating')
    expect(t.dispatched).toHaveBeenCalledOnce()
    expect(t.release).not.toHaveBeenCalled()
  })

  it('fails the turn and frees the site when core stops before a poll took the prepare', async () => {
    const t = await onRunner()
    t.hub.close()
    expect(await t.settled).toBe('released')
    expect(t.dispatched).not.toHaveBeenCalled()
    expect(t.journal.entries.slice(1)).toMatchObject([
      { phase: 'failed', reason: 'run_failed', outcome: 'failed' },
    ])
    expect(t.release).toHaveBeenCalledOnce()
    expect(t.outcome()).toBe('failed')
    expect(t.row()).toMatchObject({ taskId: null, held: false, epoch: 1 })
  })

  it('vacates when core stops after a poll took the prepare and before created', async () => {
    const t = await onRunner()
    const [prepare] = await t.poll()
    expect(prepare).toMatchObject({ type: 'prepare' })
    t.hub.close()
    // No proof that the runner created nothing: the next core closes the turn as failed.
    expect(await t.settled).toBe('vacating')
    expect(t.dispatched).toHaveBeenCalledOnce()
    expect(t.journal.entries.slice(1)).toMatchObject([{ phase: 'vacating', reason: 'run_failed' }])
    expect(t.release).not.toHaveBeenCalled()
    expect(t.finish).not.toHaveBeenCalled()
    expect(t.outcome()).toBeNull()
    expect(t.row()).toMatchObject({ taskId: labels.taskId, held: false, epoch: 1 })
  })

  /** The durable claim commits at once; its answer reaches core only once `answer` resolves. */
  function claimAnsweredLate(t: Awaited<ReturnType<typeof onRunner>>) {
    const claim = t.assignments.claim.bind(t.assignments)
    const committed = Promise.withResolvers<void>()
    const answer = Promise.withResolvers<void>()
    vi.spyOn(t.assignments, 'claim').mockImplementationOnce(async (input) => {
      const rows = await claim(input)
      committed.resolve()
      await answer.promise
      return rows
    })
    return { committed: committed.promise, answer: () => answer.resolve() }
  }

  it('never queues a prepare whose claim was answered after the owner gave the turn up', async () => {
    const t = await onRunner()
    const late = claimAnsweredLate(t)
    const polled = t.poll()
    await late.committed
    // The claim committed, its answer is still out: the owner frees the site without waiting
    // for it — nothing was queued, so no container of the turn can exist.
    t.cancel()
    expect(await t.settled).toBe('released')
    expect(t.row()).toMatchObject({ taskId: null, held: false, epoch: 1 })
    expect(t.outcome()).toBe('failed')
    late.answer()
    expect(await polled).toEqual([])
    await expect(t.preparing).rejects.toBeDefined()
    expect(await t.poll()).toEqual([])
    expect(t.dispatched).not.toHaveBeenCalled()
    expect(t.release).toHaveBeenCalledOnce()
  })
})
