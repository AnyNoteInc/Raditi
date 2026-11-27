import { describe, expect, it, vi } from 'vitest'

import { requestOnce } from './trpc.ts'

describe('requestOnce', () => {
  it('reads once per request: the procedures of a batch share the first read', async () => {
    const memo = new Map<string, Promise<unknown>>()
    const load = vi.fn(async () => 'workspace-1')

    const answers = await Promise.all([
      requestOnce({ memo }, 'personal', load),
      requestOnce({ memo }, 'personal', load),
      requestOnce({ memo }, 'personal', load),
    ])

    expect(answers).toEqual(['workspace-1', 'workspace-1', 'workspace-1'])
    expect(load).toHaveBeenCalledOnce()
  })

  it('reads again an answer it is told not to keep, and a failed read', async () => {
    const memo = new Map<string, Promise<unknown>>()
    const refused = vi.fn(async () => false)
    expect(await requestOnce({ memo }, 'consented', refused, (ok) => ok)).toBe(false)
    expect(await requestOnce({ memo }, 'consented', refused, (ok) => ok)).toBe(false)
    expect(refused).toHaveBeenCalledTimes(2)

    const failing = vi.fn(async () => {
      throw new Error('database is down')
    })
    await expect(requestOnce({ memo }, 'broken', failing)).rejects.toThrow('database is down')
    await expect(requestOnce({ memo }, 'broken', failing)).rejects.toThrow('database is down')
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it('keeps nothing for a context made by hand, without a memo', async () => {
    const load = vi.fn(async () => 1)
    await requestOnce({}, 'key', load)
    await requestOnce({}, 'key', load)
    expect(load).toHaveBeenCalledTimes(2)
  })
})
