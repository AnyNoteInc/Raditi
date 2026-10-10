import { Buffer } from 'node:buffer'

import { describe, expect, it, vi } from 'vitest'

import { createVaultSession } from './session.ts'
import { createVaultSecretStore } from './vault-secret-store.ts'

const options = { addr: 'http://vault.test:8200', token: 'synthetic-token' }
const createdTime = '2026-09-30T12:00:00.000Z'
const metadata = { version: 1, created_time: createdTime, deletion_time: '', destroyed: false }
// Go's JSON encoder may escape HTML characters even though JSON.stringify leaves them literal.
const vaultJson = (value: unknown) =>
  JSON.stringify(value).replace(
    /[<>&]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
const fullData = (pattern = 'x') => ({
  a: pattern.repeat(32_746).slice(0, 32_746),
  b: pattern.repeat(32_746).slice(0, 32_746),
})

function memoryVault() {
  let data: Record<string, string> = {}
  let custom: Record<string, string> = {}
  const responseSizes: number[] = []
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const isMetadata = String(url).includes('/metadata/')
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        data: Record<string, string>
        custom_metadata: Record<string, string>
      }
      if (isMetadata) {
        custom = body.custom_metadata
        return new Response(null, { status: 204 })
      }
      data = body.data
      return Response.json({ data: { version: 1 } })
    }
    const body = vaultJson({
      request_id: '00000000-0000-4000-8000-000000000000',
      data: isMetadata
        ? {
            current_version: 1,
            created_time: createdTime,
            custom_metadata: custom,
            versions: { '1': metadata },
          }
        : { data, metadata: { ...metadata, custom_metadata: custom } },
    })
    responseSizes.push(Buffer.byteLength(body))
    return new Response(body)
  })
  return { fetch, responseSizes, store: createVaultSecretStore({ ...options, fetch }) }
}

describe('Vault KV size budgets', () => {
  it.each(['x', '<>&'])('reads back a full 64 KiB request with pattern %s', async (pattern) => {
    const { store, responseSizes } = memoryVault()
    const data = fullData(pattern)
    expect(Buffer.byteLength(JSON.stringify({ data, options: { cas: 0 } }))).toBe(64 * 1024)
    expect(await store.kvWrite('subs/zai-coding/large', data, { cas: 0 })).toEqual({
      version: 1,
    })
    expect(await store.kvRead('subs/zai-coding/large')).toEqual({ data, version: 1 })
    expect(responseSizes[0]).toBeGreaterThan(64 * 1024)
  })

  it('allows the combined escaped data and custom metadata returned by KV', async () => {
    const { store, responseSizes } = memoryVault()
    const data = fullData('<>&')
    const custom = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`field_${i}`, '<>&'.repeat(170)]),
    )
    expect(await store.kvCreateOnce('turns/large', data, custom)).toBe('created')
    expect(await store.kvRead('turns/large')).toEqual({ data, version: 1 })
    expect(await store.kvMetadata('turns/large')).toMatchObject({ custom, currentVersion: 1 })
    expect(responseSizes[0]).toBeGreaterThan(512 * 1024)
    expect(responseSizes[1]).toBeGreaterThan(64 * 1024)
  })

  it('rejects a request one byte too large before login or any write', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const store = createVaultSecretStore({
      addr: options.addr,
      appRole: { roleId: 'synthetic-role', secretId: 'synthetic-secret' },
      fetch,
    })
    const data = fullData()
    data.b += 'x'
    await expect(store.kvWrite('turns/large', data, { cas: 0 })).rejects.toThrow(
      'Vault request exceeds the size limit',
    )
    // Custom metadata has its own, smaller server limits; they apply before the request budget.
    const custom = Object.fromEntries([
      ['a', 'x'.repeat(32_768)],
      ['b', 'x'.repeat(32_768)],
    ])
    await expect(store.kvCreateOnce('turns/large', {}, custom)).rejects.toThrow(
      'Invalid Vault KV custom metadata',
    )
    // 64 valid values of 512 bytes can still exceed the budget once JSON escapes each quote.
    const escaped = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`field_${i}`, '"'.repeat(512)]),
    )
    await expect(store.kvCreateOnce('turns/large', {}, escaped)).rejects.toThrow(
      'Vault request exceeds the size limit',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([1500, 30_000])('pages a LIST snapshot containing %i turn keys', async (count) => {
    const keys = Array.from(
      { length: count },
      (_, i) => `t_00000000-0000-4000-8000-${String(i).padStart(12, '0')}_1_1`,
    )
    const body = JSON.stringify({ data: { keys: [...keys].reverse() } })
    expect(Buffer.byteLength(body)).toBeGreaterThan(count === 1500 ? 64 * 1024 : 1024 * 1024)
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body))
    const store = createVaultSecretStore({ ...options, fetch })
    expect(await store.kvList('turns', { limit: 10 })).toEqual(keys.slice(0, 10))
    expect(await store.kvList('turns', { after: keys[9], limit: 10 })).toEqual(keys.slice(10, 20))
    expect(await store.kvList('turns', { after: keys.at(-1), limit: 10 })).toEqual([])
  })

  it.each(['read', 'metadata', 'list'] as const)(
    'accepts a %s response exactly at its byte ceiling',
    async (operation) => {
      const limit = operation === 'list' ? 16 * 1024 * 1024 : 1024 * 1024
      const data =
        operation === 'read'
          ? { data: { key: 'synthetic' }, metadata }
          : operation === 'metadata'
            ? { current_version: 1, created_time: createdTime, versions: { '1': metadata } }
            : { keys: ['a'] }
      const body = JSON.stringify({ data }).padEnd(limit, ' ')
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body))
      const store = createVaultSecretStore({ ...options, fetch })
      const result =
        operation === 'read'
          ? await store.kvRead('turns/a')
          : operation === 'metadata'
            ? await store.kvMetadata('turns/a')
            : await store.kvList('turns', { limit: 1 })
      expect(result).not.toBeNull()
    },
  )

  it.each(['read', 'metadata', 'list', 'write', 'login'] as const)(
    'cancels a chunked %s response beyond its own ceiling',
    async (operation) => {
      const limit =
        operation === 'list'
          ? 16 * 1024 * 1024
          : operation === 'read' || operation === 'metadata'
            ? 1024 * 1024
            : 64 * 1024
      let sent = 0
      const cancel = vi.fn()
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          // No Content-Length; the reader must count bytes across chunks and stop itself.
          if (sent === limit + 1) return
          const bytes = Math.min(8192, limit + 1 - sent)
          controller.enqueue(new Uint8Array(bytes).fill(32))
          sent += bytes
        },
        cancel,
      })
      const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(body))
      const store = createVaultSecretStore({
        ...options,
        ...(operation === 'login'
          ? { appRole: { roleId: 'synthetic-role', secretId: 'synthetic-secret' } }
          : {}),
        fetch,
      })
      const result =
        operation === 'write'
          ? store.kvWrite('turns/a', { key: 'synthetic' }, { cas: 0 })
          : operation === 'metadata'
            ? store.kvMetadata('turns/a')
            : operation === 'read'
              ? store.kvRead('turns/a')
              : store.kvList('turns', { limit: 1 })
      await expect(result).rejects.toThrow('Vault response exceeds the size limit')
      expect(sent).toBe(limit + 1)
      expect(cancel).toHaveBeenCalledOnce()
      expect(fetch).toHaveBeenCalledOnce()
    },
  )

  it.each(['synthetic-private-value', '__proto__', 'constructor', null, Infinity])(
    'rejects an unknown response budget before authenticating: %s',
    async (responseLimit) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      const session = createVaultSession({
        addr: options.addr,
        appRole: { roleId: 'synthetic-role', secretId: 'synthetic-secret' },
        fetch,
      })
      await expect(
        session.request('/v1/turns/metadata', {
          method: 'LIST',
          responseLimit: responseLimit as never,
        }),
      ).rejects.toThrow('Invalid Vault response limit')
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})
