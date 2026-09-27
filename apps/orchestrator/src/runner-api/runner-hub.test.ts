import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'

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
})
