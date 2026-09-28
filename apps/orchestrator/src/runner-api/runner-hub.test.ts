import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

import { runnerLimits, type TurnAssignment } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { MemoryTurnAssignments } from '../testing/turn-assignments.ts'
import { RunnerHub } from './runner-hub.ts'

describe('RunnerHub long poll', () => {
  it('ends a poll aborted while it claimed turns at once, not when its hold runs out', async () => {
    const assignments = new MemoryTurnAssignments()
    const claiming = Promise.withResolvers<void>()
    const claimed = Promise.withResolvers<void>()
    vi.spyOn(assignments, 'claim').mockImplementation(async () => {
      claiming.resolve()
      await claimed.promise
      return []
    })
    const hub = new RunnerHub({
      assignments,
      leases: { assert: vi.fn(async () => true) },
      logger: { warn: vi.fn() },
    })
    // A turn waits for a runner, so the poll claims before it waits.
    const waiting = hub.awaitClaim(randomUUID(), new AbortController().signal).catch(() => {})
    const connection = new AbortController()
    const started = performance.now()
    const polled = hub.poll(
      'sandbox-1',
      { runnerSession: randomUUID(), capacity: 1, inventory: [], active: [] },
      connection.signal,
    )
    await claiming.promise
    connection.abort()
    claimed.resolve()

    expect(await polled).toEqual({ commands: [] })
    expect(performance.now() - started).toBeLessThan(1_000)
    hub.close()
    await waiting
  })

  it('offers the store only as many waiting turns as it takes, oldest first', async () => {
    const assignments = new MemoryTurnAssignments()
    const offered: string[][] = []
    vi.spyOn(assignments, 'claim').mockImplementation(async (input) => {
      offered.push([...input.ids])
      return [{ id: input.ids[0] } as TurnAssignment]
    })
    // The first turn is given up and its abandon is still under way: it can no longer be claimed.
    vi.spyOn(assignments, 'abandon').mockReturnValue(new Promise(() => {}))
    const hub = new RunnerHub({
      assignments,
      leases: { assert: vi.fn(async () => true) },
      logger: { warn: vi.fn() },
    })
    const ids = Array.from({ length: runnerLimits.claimIds + 2 }, () => randomUUID())
    const givenUp = new AbortController()
    const claims = ids.map((id, index) =>
      hub.awaitClaim(id, index === 0 ? givenUp.signal : new AbortController().signal),
    )
    for (const claim of claims) claim.catch(() => {})
    givenUp.abort()

    const runnerSession = randomUUID()
    await hub.poll(
      'sandbox-1',
      { runnerSession, capacity: 1, inventory: [], active: [] },
      AbortSignal.timeout(100),
    )
    expect(offered[0]).toEqual(ids.slice(1, runnerLimits.claimIds + 1))
    await expect(claims[1]).resolves.toEqual({ id: 'sandbox-1', session: runnerSession })
    hub.close()
  })
})
