import type { SecretStore } from '@repo/domain'
import { kimiCodeBackend } from '@repo/llm-backends'
import { describe, expect, it, vi } from 'vitest'

import { createCredentialSource, encodeSubscriptionCredential } from './credentials.ts'

const context = {
  accountId: 'account_1',
  credentialRef: 'subs/kimi-code/account_1',
  credentialVersion: 1,
}
const credential = { v: '1', kind: 'kimi_api_key', apiKey: 'synthetic-key' }
const stored = (version = 1) => ({ data: encodeSubscriptionCredential(credential), version })

describe('subscription credential source', () => {
  it('reads the versioned canonical envelope once and coalesces simultaneous reads', async () => {
    const kvRead = vi.fn<SecretStore['kvRead']>().mockResolvedValue(stored())
    const source = createCredentialSource({ kvRead })
    const result = await Promise.all([
      source.get(context, kimiCodeBackend),
      source.get(context, kimiCodeBackend),
    ])
    expect(result).toEqual([credential, credential])
    expect(await source.get(context, kimiCodeBackend)).toEqual(credential)
    expect(kvRead).toHaveBeenCalledExactlyOnceWith(context.credentialRef)
    expect(Object.isFrozen(result[0])).toBe(true)
  })

  it('reads on a new version and after the short cache lifetime', async () => {
    let time = 0
    const kvRead = vi
      .fn<SecretStore['kvRead']>()
      .mockResolvedValueOnce(stored())
      .mockResolvedValue(stored(2))
    const source = createCredentialSource({ kvRead }, { ttlMs: 10, now: () => time })
    await source.get(context, kimiCodeBackend)
    await source.get({ ...context, credentialVersion: 2 }, kimiCodeBackend)
    time = 11
    await source.get({ ...context, credentialVersion: 2 }, kimiCodeBackend)
    expect(kvRead).toHaveBeenCalledTimes(3)
  })

  it.each([
    null,
    { ...stored(), version: 2 },
    { data: credential, version: 1 },
    { data: { credential: '{private-secret' }, version: 1 },
    { data: { credential: JSON.stringify({ ...credential, apiKey: '' }) }, version: 1 },
    { data: { credential: JSON.stringify(credential), extra: 'secret' }, version: 1 },
  ])('fails closed on missing, stale or malformed data', async (value) => {
    const kvRead = vi.fn<SecretStore['kvRead']>().mockResolvedValue(value)
    const source = createCredentialSource({ kvRead })
    await expect(source.get(context, kimiCodeBackend)).rejects.toThrow(
      'Subscription credential unavailable',
    )
  })

  it('never falls back to a cached old version or exposes Vault errors', async () => {
    const kvRead = vi
      .fn<SecretStore['kvRead']>()
      .mockResolvedValueOnce(stored())
      .mockRejectedValue(new Error('private-token'))
    const source = createCredentialSource({ kvRead })
    await source.get(context, kimiCodeBackend)
    await expect(source.get({ ...context, credentialVersion: 2 }, kimiCodeBackend)).rejects.toThrow(
      /^Subscription credential unavailable$/,
    )
  })

  it('serves the current version from memory while Vault cannot be read, for a bounded time', async () => {
    let time = 0
    const kvRead = vi.fn<SecretStore['kvRead']>().mockResolvedValueOnce(stored())
    const source = createCredentialSource(
      { kvRead },
      { ttlMs: 10, staleIfErrorMs: 1_000, now: () => time },
    )
    await source.get(context, kimiCodeBackend)
    kvRead.mockRejectedValue(new Error('private-token sealed'))
    time = 999
    expect(await source.get(context, kimiCodeBackend)).toEqual(credential)
    expect(kvRead).toHaveBeenCalledTimes(2)
    time = 1_000
    await expect(source.get(context, kimiCodeBackend)).rejects.toThrow(
      /^Subscription credential unavailable$/,
    )
  })

  it('does not fall back to memory when Vault answers with another version or after retirement', async () => {
    let time = 0
    const kvRead = vi.fn<SecretStore['kvRead']>().mockResolvedValueOnce(stored())
    const source = createCredentialSource({ kvRead }, { ttlMs: 10, now: () => time })
    await source.get(context, kimiCodeBackend)
    time = 11
    kvRead.mockResolvedValue(stored(2))
    await expect(source.get(context, kimiCodeBackend)).rejects.toThrow(
      'Subscription credential unavailable',
    )
    kvRead.mockResolvedValueOnce(stored())
    await source.get(context, kimiCodeBackend)
    source.invalidate(context.accountId)
    kvRead.mockRejectedValue(new Error('Vault unavailable'))
    await expect(source.get(context, kimiCodeBackend)).rejects.toThrow(
      'Subscription credential unavailable',
    )
  })

  it.each([
    { ...context, credentialRef: 'kv/sites/account_1' },
    { ...context, accountId: '../account_1' },
    { ...context, credentialVersion: 0 },
  ])('rejects untrusted paths or versions before Vault', async (value) => {
    const kvRead = vi.fn<SecretStore['kvRead']>()
    await expect(createCredentialSource({ kvRead }).get(value, kimiCodeBackend)).rejects.toThrow(
      'Subscription credential unavailable',
    )
    expect(kvRead).not.toHaveBeenCalled()
  })

  it('bounds the serialized KV value and keeps nulls intact', () => {
    expect(JSON.parse(encodeSubscriptionCredential({ expiry: null }).credential!)).toEqual({
      expiry: null,
    })
    expect(() => encodeSubscriptionCredential({ token: 'x'.repeat(32_768) })).toThrow(
      'Subscription credential unavailable',
    )
  })
})

describe('refresh-safe subscription credential cache', () => {
  it('uses a pinned rotation for old DB metadata until the persistence is committed', async () => {
    let time = 0
    const fresh = { ...credential, apiKey: 'synthetic-new-key' }
    const kvRead = vi.fn<SecretStore['kvRead']>().mockResolvedValue(stored())
    const source = createCredentialSource({ kvRead }, { ttlMs: 10, now: () => time })
    await source.get(context, kimiCodeBackend)
    const next = { ...context, credentialVersion: 2 }
    source.install(next, kimiCodeBackend, fresh, 1)
    time = 1_000
    expect(await source.get(context, kimiCodeBackend)).toEqual(fresh)
    expect(await source.get(next, kimiCodeBackend)).toEqual(fresh)
    expect(source.versionOf(await source.get(context, kimiCodeBackend))).toBe(2)
    expect(source.versionOf(await source.get(next, kimiCodeBackend))).toBe(2)
    expect(kvRead).toHaveBeenCalledTimes(1)
    source.commit(next)
    expect(source.versionOf(await source.get(context, kimiCodeBackend))).toBe(2)
    time = 1_011
    kvRead.mockResolvedValue({ data: encodeSubscriptionCredential(fresh), version: 2 })
    expect(await source.get(next, kimiCodeBackend)).toEqual(fresh)
    expect(source.versionOf(await source.get(next, kimiCodeBackend))).toBe(2)
    expect(kvRead).toHaveBeenCalledTimes(2)
  })

  it('does not let an in-flight old Vault read overwrite the installed rotation', async () => {
    let finish!: (value: ReturnType<typeof stored>) => void
    const kvRead = vi
      .fn<SecretStore['kvRead']>()
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const source = createCredentialSource({ kvRead })
    const reading = source.get(context, kimiCodeBackend)
    const fresh = { ...credential, apiKey: 'synthetic-new-key' }
    source.install({ ...context, credentialVersion: 2 }, kimiCodeBackend, fresh, 1)
    finish(stored())
    expect(await reading).toEqual(fresh)
    expect(await source.get(context, kimiCodeBackend)).toEqual(fresh)
  })

  it('invalidates an in-flight read after retirement', async () => {
    let finish!: (value: ReturnType<typeof stored>) => void
    const kvRead = vi
      .fn<SecretStore['kvRead']>()
      .mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const source = createCredentialSource({ kvRead })
    const reading = source.get(context, kimiCodeBackend)
    source.invalidate(context.accountId)
    finish(stored())
    await expect(reading).rejects.toThrow('Subscription credential unavailable')
  })

  it('keeps pending rotations when an ordinary cache read evicts older entries', async () => {
    const kvRead = vi.fn<SecretStore['kvRead']>().mockResolvedValue(stored())
    const source = createCredentialSource({ kvRead }, { maxEntries: 1 })
    const fresh = { ...credential, apiKey: 'synthetic-new-key' }
    source.install({ ...context, credentialVersion: 2 }, kimiCodeBackend, fresh, 1)
    await source.get(
      { ...context, accountId: 'account_2', credentialRef: 'subs/kimi-code/account_2' },
      kimiCodeBackend,
    )
    expect(await source.get(context, kimiCodeBackend)).toEqual(fresh)
  })
})
