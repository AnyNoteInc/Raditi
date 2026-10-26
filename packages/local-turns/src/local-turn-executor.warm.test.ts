import { MAX_SANDBOX_TURN_MS, type TurnPrepareInput } from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { LocalTurnExecutor } from './local-turn-executor.ts'
import { credentials, fence, image, labels, prepareInput, sandboxSide } from './testing.ts'
import { WarmSandboxes } from './warm-sandboxes.ts'

// The warm containers of turns (spec §8, «Тёплая песочница»): the container of a completed turn
// waits for the next turn of its task, which prepares it as a new one.
vi.mock('./working-tree-export.ts', () => ({
  exportSandboxWorkingTree: vi.fn(async () => ({ archive: new Uint8Array([1]), deletes: [] })),
}))

const MINUTE = 60_000
const signal = new AbortController().signal

function warmSide() {
  const side = sandboxSide()
  side.sandbox.reset = vi.fn(async () => {})
  const warm = new WarmSandboxes({
    sandboxes: side.sandboxes,
    warmMs: 10 * MINUTE,
    wanted: async (ids) => new Set(ids),
  })
  const executor = new LocalTurnExecutor({
    sandboxes: side.sandboxes,
    parser: () => ({ parseEvent: () => [] }),
    transport: side.snapshot,
    transfer: side.transfer,
    importBundle: side.importBundle,
    warm,
  })
  return { ...side, warm, executor }
}

/** Turn `turn` of the task under lease epoch `epoch`, with the whole turn limit. */
function turnInput(turn: number, epoch: number, patch: Partial<TurnPrepareInput['sandbox']> = {}) {
  const input = prepareInput(`assignment${turn}`)
  return {
    ...input,
    fence: { ...fence, epoch },
    sandbox: {
      ...input.sandbox,
      labels: { ...labels, turn, leaseEpoch: epoch },
      hardTimeoutMs: MAX_SANDBOX_TURN_MS,
      ...patch,
    },
  }
}

describe('warm containers of the local executor', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-26T10:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('leaves the container of a completed turn to the next turn, prepared as a new one', async () => {
    const side = warmSide()
    const first = await side.executor.prepare(turnInput(1, 1), signal)
    await first.destroy('completed')
    expect(side.sandbox.reset).toHaveBeenCalledOnce()
    expect(side.sandbox.destroy).not.toHaveBeenCalled()
    expect(side.warm.holds(side.sandbox.id)).toBe(true)
    // Left to the next turn: nothing of the first turn touches it any more.
    await expect(first.quiesce()).rejects.toMatchObject({ code: 'CONFLICT' })
    await first.destroy('completed')
    expect(side.sandbox.destroy).not.toHaveBeenCalled()

    vi.setSystemTime(Date.now() + 4 * MINUTE)
    const writes = vi.mocked(side.sandbox.fs.write).mock.calls.length
    const second = turnInput(2, 2)
    const execution = await side.executor.prepare(second, signal)
    expect(side.sandboxes.create).toHaveBeenCalledOnce()
    expect(second.created).toHaveBeenCalledWith(execution)
    expect(execution.containerId).toBe(side.sandbox.id)
    // The base and the files of the turn are laid out again, its own secret among them.
    expect(side.importBundle).toHaveBeenCalledTimes(2)
    expect(vi.mocked(side.sandbox.fs.write).mock.calls.length - writes).toBe(2)
    // The container keeps the deadline it was created with: the agent ends four minutes earlier.
    await execution.launch(17 * MINUTE)
    expect(vi.mocked(side.sandbox.exec).mock.lastCall![0].timeoutMs).toBe(13 * MINUTE)

    // The preview and recovery of turn 2 find it by the id the assignment names, under the
    // labels of turn 1 it was created with.
    const { leaseEpoch: _epoch, ...turnLabels } = second.sandbox.labels
    await expect(
      side.executor.exportWorkingTree(
        {
          assignmentId: second.assignmentId,
          containerId: side.sandbox.id,
          labels: turnLabels,
          baseSha: 'b'.repeat(40),
        },
        signal,
      ),
    ).resolves.toBeDefined()
    const adopted = await side.executor.adopt(
      {
        assignmentId: second.assignmentId,
        fence: second.fence,
        containerId: side.sandbox.id,
        labels: second.sandbox.labels,
        purpose: 'work',
        remainingMs: 10 * MINUTE,
        driverId: second.driverId,
        credentials,
      },
      signal,
    )
    expect(adopted?.containerId).toBe(side.sandbox.id)
    // A later turn never shares the epoch the container was created under.
    await expect(
      side.executor.adopt(
        {
          assignmentId: second.assignmentId,
          fence: second.fence,
          containerId: side.sandbox.id,
          labels: { ...second.sandbox.labels, leaseEpoch: 1 },
          purpose: 'removal',
        },
        signal,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    await side.warm.close()
  })

  it('removes the container of a turn that did not complete', async () => {
    const side = warmSide()
    for (const reason of ['failed', 'cancelled', 'timeout'] as const) {
      const execution = await side.executor.prepare(turnInput(1, 1), signal)
      await execution.destroy(reason)
      expect(side.warm.holds(side.sandbox.id)).toBe(false)
    }
    expect(side.sandbox.reset).not.toHaveBeenCalled()
    expect(side.sandbox.destroy).toHaveBeenCalledTimes(3)
    expect(side.sandboxes.create).toHaveBeenCalledTimes(3)
  })

  it('creates a new container for a turn of another container spec, or when it waited too long', async () => {
    const side = warmSide()
    const first = await side.executor.prepare(turnInput(1, 1), signal)
    await first.destroy('completed')
    const otherImage = image.replace(/a{64}/, 'c'.repeat(64))
    const second = await side.executor.prepare(turnInput(2, 2, { image: otherImage }), signal)
    expect(side.sandboxes.create).toHaveBeenCalledTimes(2)
    await second.destroy('failed')
    // Past half of its deadline it is no longer offered: the next turn would get too little.
    vi.setSystemTime(Date.now() + 11 * MINUTE)
    await side.executor.prepare(turnInput(3, 3), signal)
    expect(side.sandboxes.create).toHaveBeenCalledTimes(3)
    await side.warm.close()
  })
})
