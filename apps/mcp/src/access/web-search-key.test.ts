import { WEB_SEARCH_KEY_PATH, type KvSecret } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { WebSearchKey } from './web-search-key.ts'

const key = 'synthetic-yandex-key-0123456789'
const folderId = 'b1gsynthetic000folder'
const access = { apiKey: key, folderId }

describe('WebSearchKey', () => {
  it('reads the key and the folder of subs/search/yandex and keeps them for a while', async () => {
    const kvRead = vi.fn(async () => ({ data: { key, folderId }, version: 1 }))
    let now = 0
    const reader = new WebSearchKey({ kvRead }, { ttlMs: 1000, now: () => now })
    await expect(reader.read()).resolves.toEqual(access)
    await expect(reader.available()).resolves.toBe(true)
    expect(kvRead).toHaveBeenCalledOnce()
    expect(kvRead).toHaveBeenCalledWith(WEB_SEARCH_KEY_PATH)
    expect(WEB_SEARCH_KEY_PATH).toBe('subs/search/yandex')
    now = 1001
    await reader.read()
    expect(kvRead).toHaveBeenCalledTimes(2)
  })

  it('has no key while the path is empty, a field is missing or malformed, or Vault is out of reach, and sees one imported later', async () => {
    const answers: (KvSecret | null | Error)[] = [
      null,
      { data: { key: 'short', folderId }, version: 1 },
      { data: { key }, version: 1 },
      { data: { key, folderId: 'Not A Folder!' }, version: 1 },
      new Error('Vault answered 403'),
      { data: { key, folderId }, version: 2 },
    ]
    const kvRead = vi.fn(async () => {
      const next = answers.shift()
      if (next instanceof Error) throw next
      return next ?? null
    })
    let now = 0
    const reader = new WebSearchKey({ kvRead }, { ttlMs: 10, now: () => now })
    for (let at = 0; at < 5; at++) {
      await expect(reader.available()).resolves.toBe(false)
      now += 11
    }
    await expect(reader.read()).resolves.toEqual(access)
  })

  it('reads Vault once for calls that come together', async () => {
    let release!: () => void
    const kvRead = vi.fn(
      () =>
        new Promise<{ data: Record<string, string>; version: number }>((resolve) => {
          release = () => resolve({ data: { key, folderId }, version: 1 })
        }),
    )
    const reader = new WebSearchKey({ kvRead })
    const reads = [reader.read(), reader.read(), reader.available()]
    release()
    await expect(Promise.all(reads)).resolves.toEqual([access, access, true])
    expect(kvRead).toHaveBeenCalledOnce()
  })
})
