import { WEB_SEARCH_KEY_PATH, type KvSecret } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { WebSearchKey } from './web-search-key.ts'

const key = 'synthetic-parallel-key-0123456789'

describe('WebSearchKey', () => {
  it('reads the key of subs/search/parallel and keeps it for a while', async () => {
    const kvRead = vi.fn(async () => ({ data: { key }, version: 1 }))
    let now = 0
    const reader = new WebSearchKey({ kvRead }, { ttlMs: 1000, now: () => now })
    await expect(reader.read()).resolves.toBe(key)
    await expect(reader.available()).resolves.toBe(true)
    expect(kvRead).toHaveBeenCalledOnce()
    expect(kvRead).toHaveBeenCalledWith(WEB_SEARCH_KEY_PATH)
    expect(WEB_SEARCH_KEY_PATH).toBe('subs/search/parallel')
    now = 1001
    await reader.read()
    expect(kvRead).toHaveBeenCalledTimes(2)
  })

  it('has no key while the path is empty, malformed or out of reach, and sees one imported later', async () => {
    const answers: (KvSecret | null | Error)[] = [
      null,
      { data: { key: 'short' }, version: 1 },
      { data: {}, version: 1 },
      new Error('Vault answered 403'),
      { data: { key }, version: 2 },
    ]
    const kvRead = vi.fn(async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next ?? null
    })
    let now = 0
    const reader = new WebSearchKey({ kvRead }, { ttlMs: 10, now: () => now })
    for (let at = 0; at < 4; at++) {
      await expect(reader.available()).resolves.toBe(false)
      now += 11
    }
    await expect(reader.read()).resolves.toBe(key)
  })

  it('reads Vault once for calls that come together', async () => {
    let release!: () => void
    const kvRead = vi.fn(
      () =>
        new Promise<{ data: Record<string, string>; version: number }>((resolve) => {
          release = () => resolve({ data: { key }, version: 1 })
        }),
    )
    const reader = new WebSearchKey({ kvRead })
    const reads = [reader.read(), reader.read(), reader.available()]
    release()
    await expect(Promise.all(reads)).resolves.toEqual([key, key, true])
    expect(kvRead).toHaveBeenCalledOnce()
  })
})
