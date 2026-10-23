import { describe, expect, it } from 'vitest'

import { LivePasses } from './live-passes.ts'

describe('LivePasses', () => {
  it('stops the live pass of a task and lets one pass in at a time', () => {
    const live = new LivePasses()
    const controller = live.enter('task')!
    expect(live.enter('task')).toBeNull()
    expect(live.has('task')).toBe(true)
    expect(live.abort('task')).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    live.leave('task', new AbortController())
    expect(live.has('task')).toBe(true)
    live.leave('task', controller)
    expect(live.abort('task')).toBe(false)
  })
})
