import { artifactRenderLimits } from '@repo/domain/artifacts'
import { describe, expect, it, vi } from 'vitest'

import { RenderPool } from './render-pool.ts'

// The pool of render containers (docs/plan/88-artifacts.md, §7.12): two renders on one Chromium,
// a container of the runtime without any host, replaced after its renders or when its browser
// went away; no renderer at all in production without the runtime's images.

const renderer = () => {
  let connected = true
  return {
    render: vi.fn(),
    connected: () => connected,
    close: vi.fn(async () => {
      connected = false
    }),
    drop: () => {
      connected = false
    },
  }
}

describe('the pool of render containers', () => {
  it('starts a container that reaches no host and keeps two renders on it', async () => {
    const made = renderer()
    const runtime = {
      start: vi.fn(async () => ({ endpoint: 'ws://127.0.0.1:1/secret' })),
      stop: vi.fn(async () => undefined),
      extend: vi.fn(),
      list: vi.fn(async () => []),
    }
    const create = vi.fn(async () => made)
    const pool = new RenderPool({ runtime, local: false, containers: 1, create })
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => (release = resolve))
    const first = pool.run(() => held)
    const second = pool.run(() => held)
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    expect(runtime.start).toHaveBeenCalledTimes(1)
    const spec = (runtime.start.mock.calls[0] as unknown as [Record<string, unknown>])[0]
    expect(spec).toMatchObject({ allowedHosts: [], openWeb: false, closed: true, localSites: [] })
    expect(pool.holds(spec.sessionId as string)).toBe(true)
    expect(create).toHaveBeenCalledWith({ endpoint: 'ws://127.0.0.1:1/secret' })
    release()
    await Promise.all([first, second])
    await pool.close()
    expect(runtime.stop).toHaveBeenCalledWith(spec.sessionId)
  })

  it('reserves the last slot before another request can take it', async () => {
    const pool = new RenderPool({
      runtime: null,
      local: true,
      containers: 1,
      create: async () => renderer(),
    })
    const first = Promise.withResolvers<void>()
    const next = Promise.withResolvers<void>()
    const running = vi.fn(() => next.promise)
    const held = pool.run(() => first.promise)
    const second = pool.run(running)
    const third = pool.run(running)
    try {
      await vi.waitFor(() => expect(running).toHaveBeenCalledTimes(1))
      first.resolve()
      await vi.waitFor(() => expect(running).toHaveBeenCalledTimes(2))
    } finally {
      first.resolve()
      next.resolve()
      await Promise.all([held, second, third])
      await pool.close()
    }
  })

  it('replaces a renderer after its renders, and one whose browser went away', async () => {
    const made = [renderer(), renderer(), renderer()]
    let at = 0
    const create = vi.fn(async () => made[at++]!)
    const pool = new RenderPool({ runtime: null, local: true, containers: 1, create })
    for (let n = 0; n < artifactRenderLimits.containerRenders; n += 1) await pool.run(async () => n)
    await vi.waitFor(() => expect(made[0]!.close).toHaveBeenCalled())
    await pool.run(async () => 0)
    expect(create).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenLastCalledWith({ launch: true })
    made[1]!.drop()
    await pool.run(async () => 0)
    expect(create).toHaveBeenCalledTimes(3)
    await pool.close()
  })

  it('renders nothing without the runtime where a local Chromium is not allowed', async () => {
    const pool = new RenderPool({ runtime: null, local: false, containers: 2, create: vi.fn() })
    expect(pool.available).toBe(false)
    await expect(pool.run(async () => 1)).rejects.toMatchObject({ code: 'RENDER_UNAVAILABLE' })
  })
})
