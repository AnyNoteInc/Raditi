import type { Sandbox } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { labels } from './testing.ts'
import { WARM_LEASE_MARGIN_MS, WARM_TAKE_MIN_LEFT_MS, WarmSandboxes } from './warm-sandboxes.ts'

const MINUTE = 60_000
const fakeSandbox = (id: string, taskId = labels.taskId): Sandbox => {
  const sandbox: Sandbox = {
    id,
    labels: { ...labels, taskId, leaseEpoch: 1 },
    deadline: Date.now() + 4 * MINUTE,
    exec: vi.fn(),
    attach: vi.fn(),
    quiesce: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    extend: vi.fn(async (deadline: number) => {
      ;(sandbox as { deadline: number }).deadline = Math.max(sandbox.deadline, deadline)
    }),
    fs: { write: vi.fn(), read: vi.fn(), list: vi.fn(), remove: vi.fn() },
    destroy: vi.fn(async () => {}),
  }
  return sandbox
}

function pool(options: { wanted?: (ids: readonly string[]) => Promise<ReadonlySet<string>> } = {}) {
  const sandboxes = new Map<string, Sandbox>()
  const get = vi.fn(async (id: string) => sandboxes.get(id) ?? null)
  const wanted = vi.fn(options.wanted ?? (async (ids: readonly string[]) => new Set(ids)))
  const warm = new WarmSandboxes({ sandboxes: { get }, warmMs: 10 * MINUTE, wanted, sweepMs: 1000 })
  /**
   * A container the provider still returns: a fresh wrapper of the same container, with the
   * deadline its latest lease gives it.
   */
  const known = (sandbox: Sandbox) => {
    sandboxes.set(sandbox.id, {
      ...sandbox,
      get deadline() {
        return sandbox.deadline
      },
      destroy: vi.fn(async () => {}),
    })
    return sandbox
  }
  return { warm, get, wanted, known, sandboxes }
}

describe('warm containers of turns', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resets the container of a completed turn, leases it for its wait and hands it on', async () => {
    const { warm, known, wanted } = pool()
    const sandbox = known(fakeSandbox('c1'))
    const before = Date.now()
    expect(await warm.park(sandbox, 'k')).toBe(true)
    expect(sandbox.reset).toHaveBeenCalledOnce()
    expect(wanted).toHaveBeenCalledWith([labels.taskId])
    // Leased for its wait, however short its turn left it (plan 70, ВР10).
    const leased = vi.mocked(sandbox.extend).mock.calls[0]![0]
    expect(leased).toBeGreaterThanOrEqual(before + 10 * MINUTE + WARM_LEASE_MARGIN_MS)
    expect(warm.holds('c1')).toBe(true)
    // Another task, session or container spec never gets it.
    expect(await warm.take('other')).toBeNull()
    const taken = await warm.take('k')
    expect(taken).toMatchObject({ id: 'c1' })
    // Checked again by its provider: the turn works in the wrapper it returned.
    expect(taken).not.toBe(sandbox)
    expect(sandbox.destroy).not.toHaveBeenCalled()
    // Taken: held while the turn runs in it, once only.
    expect(warm.holds('c1')).toBe(true)
    expect(await warm.take('k')).toBeNull()
    warm.forget('c1')
    expect(warm.holds('c1')).toBe(false)
  })

  it('lets a container wait only when it was reset, leased and its task goes on', async () => {
    const { warm, known } = pool({ wanted: async () => new Set() })
    // Its task ended or its site was deleted.
    expect(await warm.park(known(fakeSandbox('c1')), 'k')).toBe(false)
    // A provider that cannot reset it.
    const plain = known(fakeSandbox('c3'))
    delete plain.reset
    const { warm: other, known: otherKnown } = pool()
    expect(await other.park(plain, 'k')).toBe(false)
    const failing = otherKnown(fakeSandbox('c4'))
    vi.mocked(failing.reset!).mockRejectedValueOnce(new Error('reset failed'))
    expect(await other.park(failing, 'k')).toBe(false)
    // Its lease could not be written: the watchdog would remove it while it waits.
    const unleased = otherKnown(fakeSandbox('c5'))
    vi.mocked(unleased.extend).mockRejectedValueOnce(new Error('daemon unavailable'))
    expect(await other.park(unleased, 'k')).toBe(false)
    for (const id of ['c1', 'c3', 'c4', 'c5']) expect(warm.holds(id) || other.holds(id)).toBe(false)
  })

  it('removes a container its provider refuses or whose lease runs out', async () => {
    const { warm, known, sandboxes } = pool()
    const changed = known(fakeSandbox('c2'))
    expect(await warm.park(changed, 'k')).toBe(true)
    sandboxes.delete('c2')
    expect(await warm.take('k')).toBeNull()
    expect(changed.destroy).toHaveBeenCalledOnce()
    expect(warm.holds('c2')).toBe(false)
    // Its lease leaves the taking turn no time to extend it.
    const ending = known(fakeSandbox('c3'))
    expect(await warm.park(ending, 'k')).toBe(true)
    ;(ending as { deadline: number }).deadline = Date.now() + WARM_TAKE_MIN_LEFT_MS - 1
    expect(await warm.take('k')).toBeNull()
    expect(ending.destroy).toHaveBeenCalledOnce()
  })

  it('removes a waiting container after its warm minutes', async () => {
    vi.useFakeTimers()
    const { warm, known } = pool()
    const sandbox = known(fakeSandbox('c1'))
    expect(await warm.park(sandbox, 'k1')).toBe(true)
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1)
    expect(sandbox.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(sandbox.destroy).toHaveBeenCalledOnce()
    expect(warm.holds('c1')).toBe(false)
  })

  it('removes the containers of tasks that ended, and all of them when the check fails', async () => {
    vi.useFakeTimers()
    let open = new Set([labels.taskId, 'other-task'])
    const { warm, known, wanted } = pool({
      wanted: async (ids) => new Set(ids.filter((id) => open.has(id))),
    })
    const first = known(fakeSandbox('c1'))
    const second = known(fakeSandbox('c2', 'other-task'))
    expect(await warm.park(first, 'k1')).toBe(true)
    expect(await warm.park(second, 'k2')).toBe(true)
    open = new Set(['other-task'])
    await vi.advanceTimersByTimeAsync(1000)
    expect(first.destroy).toHaveBeenCalledOnce()
    expect(second.destroy).not.toHaveBeenCalled()
    wanted.mockRejectedValueOnce(new Error('database unavailable'))
    await vi.advanceTimersByTimeAsync(1000)
    expect(second.destroy).toHaveBeenCalledOnce()
    expect(warm.holds('c2')).toBe(false)
  })

  it('removes the waiting containers when it closes, never one a turn took', async () => {
    const { warm, known } = pool()
    const waiting = known(fakeSandbox('c1'))
    const taken = known(fakeSandbox('c2', 'other-task'))
    expect(await warm.park(waiting, 'k1')).toBe(true)
    expect(await warm.park(taken, 'k2')).toBe(true)
    const inTurn = (await warm.take('k2'))!
    await warm.close()
    expect(waiting.destroy).toHaveBeenCalledOnce()
    expect(inTurn.destroy).not.toHaveBeenCalled()
    expect(warm.holds('c2')).toBe(true)
    // Nothing waits after it.
    expect(await warm.park(known(fakeSandbox('c3')), 'k3')).toBe(false)
    expect(await warm.take('k2')).toBeNull()
  })

  it('keeps at most its limit waiting: one more takes the place of the one that ends first', async () => {
    vi.useFakeTimers()
    const sandboxes = new Map<string, Sandbox>()
    const warm = new WarmSandboxes({
      sandboxes: { get: async (id) => sandboxes.get(id) ?? null },
      warmMs: 10 * MINUTE,
      wanted: async (ids) => new Set(ids),
      maxWaiting: 2,
    })
    const [a, b, c] = ['c1', 'c2', 'c3'].map((id) => fakeSandbox(id, `task-${id}`))
    expect(await warm.park(a!, 'k1')).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await warm.park(b!, 'k2')).toBe(true)
    expect(await warm.park(c!, 'k3')).toBe(true)
    // The one that waited longest ends first.
    expect(a!.destroy).toHaveBeenCalledOnce()
    expect([a, b, c].map((sandbox) => warm.holds(sandbox!.id))).toEqual([false, true, true])
    await warm.close()
  })

  it('forgets a container recovery removed while it waited', async () => {
    const { warm, known } = pool()
    const sandbox = known(fakeSandbox('c1'))
    expect(await warm.park(sandbox, 'k')).toBe(true)
    warm.forget('c1')
    expect(warm.holds('c1')).toBe(false)
    expect(await warm.take('k')).toBeNull()
    expect(sandbox.destroy).not.toHaveBeenCalled()
  })
})
