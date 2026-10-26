import type { Sandbox } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { labels } from './testing.ts'
import { WARM_MIN_LEFT_MS, WarmSandboxes } from './warm-sandboxes.ts'

const MINUTE = 60_000
const fakeSandbox = (id: string, taskId = labels.taskId): Sandbox => ({
  id,
  labels: { ...labels, taskId, leaseEpoch: 1 },
  exec: vi.fn(),
  attach: vi.fn(),
  quiesce: vi.fn(async () => {}),
  reset: vi.fn(async () => {}),
  fs: { write: vi.fn(), read: vi.fn(), list: vi.fn(), remove: vi.fn() },
  destroy: vi.fn(async () => {}),
})

function pool(options: { wanted?: (ids: readonly string[]) => Promise<ReadonlySet<string>> } = {}) {
  const sandboxes = new Map<string, Sandbox>()
  const get = vi.fn(async (id: string) => sandboxes.get(id) ?? null)
  const wanted = vi.fn(options.wanted ?? (async (ids: readonly string[]) => new Set(ids)))
  const warm = new WarmSandboxes({ sandboxes: { get }, warmMs: 10 * MINUTE, wanted, sweepMs: 1000 })
  /** A container the provider still returns: a fresh wrapper of the same container. */
  const known = (sandbox: Sandbox) => {
    sandboxes.set(sandbox.id, { ...sandbox, destroy: vi.fn(async () => {}) })
    return sandbox
  }
  return { warm, get, wanted, known, sandboxes }
}

describe('warm containers of turns', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resets the container of a completed turn and hands it to the next turn of its key', async () => {
    const { warm, known, wanted } = pool()
    const sandbox = known(fakeSandbox('c1'))
    const deadline = Date.now() + 19 * MINUTE
    expect(await warm.park(sandbox, 'k', deadline)).toBe(true)
    expect(sandbox.reset).toHaveBeenCalledOnce()
    expect(wanted).toHaveBeenCalledWith([labels.taskId])
    expect(warm.holds('c1')).toBe(true)
    // Another task, session or container spec never gets it.
    expect(await warm.take('other', MINUTE)).toBeNull()
    const taken = await warm.take('k', WARM_MIN_LEFT_MS)
    expect(taken).toMatchObject({ sandbox: { id: 'c1' }, deadline })
    // Checked again by its provider: the turn works in the wrapper it returned.
    expect(taken!.sandbox).not.toBe(sandbox)
    expect(sandbox.destroy).not.toHaveBeenCalled()
    // Taken: held while the turn runs in it, once only.
    expect(warm.holds('c1')).toBe(true)
    expect(await warm.take('k', WARM_MIN_LEFT_MS)).toBeNull()
    warm.forget('c1')
    expect(warm.holds('c1')).toBe(false)
  })

  it('lets a container wait only when it was reset, its task goes on and its deadline allows', async () => {
    const { warm, known } = pool({ wanted: async () => new Set() })
    const soon = Date.now() + WARM_MIN_LEFT_MS
    const later = Date.now() + 19 * MINUTE
    // Its task ended or its site was deleted.
    expect(await warm.park(known(fakeSandbox('c1')), 'k', later)).toBe(false)
    // It would not leave the next turn half of a turn.
    expect(await warm.park(known(fakeSandbox('c2')), 'k', soon)).toBe(false)
    // A provider that cannot reset it.
    const plain = known(fakeSandbox('c3'))
    delete plain.reset
    expect(await warm.park(plain, 'k', later)).toBe(false)
    const failing = known(fakeSandbox('c4'))
    vi.mocked(failing.reset!).mockRejectedValueOnce(new Error('reset failed'))
    const { warm: other, known: otherKnown } = pool()
    expect(await other.park(otherKnown(failing), 'k', later)).toBe(false)
    for (const id of ['c1', 'c2', 'c3', 'c4']) expect(warm.holds(id) || other.holds(id)).toBe(false)
  })

  it('removes a container that no longer leaves the turn enough, or that its provider refuses', async () => {
    const { warm, known, sandboxes } = pool()
    const short = known(fakeSandbox('c1'))
    expect(await warm.park(short, 'k', Date.now() + 12 * MINUTE)).toBe(true)
    expect(await warm.take('k', 13 * MINUTE)).toBeNull()
    expect(short.destroy).toHaveBeenCalledOnce()
    const changed = known(fakeSandbox('c2'))
    expect(await warm.park(changed, 'k', Date.now() + 19 * MINUTE)).toBe(true)
    sandboxes.delete('c2')
    expect(await warm.take('k', MINUTE)).toBeNull()
    expect(changed.destroy).toHaveBeenCalledOnce()
    expect(warm.holds('c2')).toBe(false)
  })

  it('removes a waiting container after its warm minutes, or before the deadline leaves too little', async () => {
    vi.useFakeTimers()
    const { warm, known } = pool()
    const long = known(fakeSandbox('c1'))
    const short = known(fakeSandbox('c2', 'other-task'))
    expect(await warm.park(long, 'k1', Date.now() + 20 * MINUTE)).toBe(true)
    expect(await warm.park(short, 'k2', Date.now() + 15 * MINUTE)).toBe(true)
    await vi.advanceTimersByTimeAsync(5 * MINUTE + 1)
    // 15 minutes of deadline left half of a turn for 5 minutes only.
    expect(short.destroy).toHaveBeenCalledOnce()
    expect(long.destroy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(long.destroy).toHaveBeenCalledOnce()
    expect(warm.holds('c1') || warm.holds('c2')).toBe(false)
  })

  it('removes the containers of tasks that ended, and all of them when the check fails', async () => {
    vi.useFakeTimers()
    let open = new Set([labels.taskId, 'other-task'])
    const { warm, known, wanted } = pool({
      wanted: async (ids) => new Set(ids.filter((id) => open.has(id))),
    })
    const first = known(fakeSandbox('c1'))
    const second = known(fakeSandbox('c2', 'other-task'))
    const deadline = Date.now() + 19 * MINUTE
    expect(await warm.park(first, 'k1', deadline)).toBe(true)
    expect(await warm.park(second, 'k2', deadline)).toBe(true)
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
    const deadline = Date.now() + 19 * MINUTE
    const waiting = known(fakeSandbox('c1'))
    const taken = known(fakeSandbox('c2', 'other-task'))
    expect(await warm.park(waiting, 'k1', deadline)).toBe(true)
    expect(await warm.park(taken, 'k2', deadline)).toBe(true)
    const inTurn = (await warm.take('k2', MINUTE))!.sandbox
    await warm.close()
    expect(waiting.destroy).toHaveBeenCalledOnce()
    expect(inTurn.destroy).not.toHaveBeenCalled()
    expect(warm.holds('c2')).toBe(true)
    // Nothing waits after it.
    expect(await warm.park(known(fakeSandbox('c3')), 'k3', deadline)).toBe(false)
    expect(await warm.take('k2', MINUTE)).toBeNull()
  })

  it('keeps at most its limit waiting: one more takes the place of the one that ends first', async () => {
    const sandboxes = new Map<string, Sandbox>()
    const warm = new WarmSandboxes({
      sandboxes: { get: async (id) => sandboxes.get(id) ?? null },
      warmMs: 10 * MINUTE,
      wanted: async (ids) => new Set(ids),
      maxWaiting: 2,
    })
    const [a, b, c] = ['c1', 'c2', 'c3'].map((id) => fakeSandbox(id, `task-${id}`))
    expect(await warm.park(a!, 'k1', Date.now() + 19 * MINUTE)).toBe(true)
    expect(await warm.park(b!, 'k2', Date.now() + 15 * MINUTE)).toBe(true)
    expect(await warm.park(c!, 'k3', Date.now() + 19 * MINUTE)).toBe(true)
    expect(b!.destroy).toHaveBeenCalledOnce()
    expect([a, b, c].map((sandbox) => warm.holds(sandbox!.id))).toEqual([true, false, true])
    await warm.close()
  })

  it('forgets a container recovery removed while it waited', async () => {
    const { warm, known } = pool()
    const sandbox = known(fakeSandbox('c1'))
    expect(await warm.park(sandbox, 'k', Date.now() + 19 * MINUTE)).toBe(true)
    warm.forget('c1')
    expect(warm.holds('c1')).toBe(false)
    expect(await warm.take('k', MINUTE)).toBeNull()
    expect(sandbox.destroy).not.toHaveBeenCalled()
  })
})
