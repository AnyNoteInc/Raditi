import { describe, expect, it, vi } from 'vitest'

import { PreviewLoops, previewLoopTimings } from './preview-loops.ts'

function manager(rows: {
  sync: Array<{ id: string; previewId: string }>
  browser: Array<{ id: string; previewId: string }>
}) {
  const gates = new Map<string, PromiseWithResolvers<boolean>>()
  const served: string[] = []
  const serve = (id: string) => {
    served.push(id)
    const gate = Promise.withResolvers<boolean>()
    gates.set(id, gate)
    return gate.promise
  }
  return {
    gates,
    served,
    pendingRequests: vi.fn(() => Promise.resolve(rows)),
    serveSync: vi.fn(serve),
    serveBrowser: vi.fn(serve),
    sweep: vi.fn(() => Promise.resolve()),
    isWorking: vi.fn(() => false),
    idle: vi.fn(() => Promise.resolve()),
  }
}

describe('the loops of the manager of previews', () => {
  it('serves rows of different previews side by side and one row of a preview at a time', async () => {
    const m = manager({
      sync: [
        { id: 's1', previewId: 'p1' },
        { id: 's2', previewId: 'p1' },
        { id: 's3', previewId: 'p2' },
      ],
      browser: [{ id: 'b1', previewId: 'p3' }],
    })
    const loops = new PreviewLoops(m, false)
    await loops.requests()
    expect(m.served).toEqual(['s1', 's3', 'b1'])
    // The next pass leaves the previews being served alone.
    await loops.requests()
    expect(m.served).toEqual(['s1', 's3', 'b1'])
    m.gates.get('s1')!.resolve(true)
    await new Promise((resolve) => setImmediate(resolve))
    await loops.requests()
    expect(m.served).toEqual(['s1', 's3', 'b1', 's1'])
    for (const gate of m.gates.values()) gate.resolve(true)
    await loops.onModuleDestroy()
  })

  it('serves at most a few previews at once', async () => {
    const sync = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, previewId: `p${i}` }))
    const m = manager({ sync, browser: [] })
    const loops = new PreviewLoops(m, false)
    await loops.requests()
    expect(m.served).toHaveLength(previewLoopTimings.parallel)
    for (const gate of m.gates.values()) gate.resolve(true)
    await loops.onModuleDestroy()
  })

  it('never runs two sweeps at once and nothing without a manager or after closing', async () => {
    const m = manager({ sync: [], browser: [] })
    const gate = Promise.withResolvers<void>()
    m.sweep.mockImplementationOnce(() => gate.promise)
    const loops = new PreviewLoops(m, false)
    const first = loops.sweep()
    const second = loops.sweep()
    expect(first).toBe(second)
    expect(m.sweep).toHaveBeenCalledTimes(1)
    gate.resolve()
    await first
    await loops.onModuleDestroy()
    // The builds the sweep left running beside it are waited for on the way out.
    expect(m.idle).toHaveBeenCalled()
    await loops.sweep()
    expect(m.sweep).toHaveBeenCalledTimes(1)
    await new PreviewLoops(null, true).requests()
  })
})
