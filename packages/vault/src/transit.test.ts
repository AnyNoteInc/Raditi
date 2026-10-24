import { Buffer } from 'node:buffer'
import { inspect } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createVaultSecretStore } from './vault-secret-store.ts'

const keyBytes = Buffer.alloc(32, 23)
const plaintext = keyBytes.toString('base64')
const ciphertext = `vault:v1:${Buffer.alloc(60, 42).toString('base64')}`
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const datakey = () => reply({ data: { plaintext, ciphertext } })
const loginReply = (token = 'service-token', lease = 60) =>
  reply({ auth: { client_token: token, lease_duration: lease } })
const options = { addr: 'http://vault.test:8200/', token: 'dev-test-token' }
const role = { roleId: 'test-role', secretId: 'test-secret-id' }
const withFetch = (fetch: typeof globalThis.fetch) => createVaultSecretStore({ ...options, fetch })

afterEach(() => vi.restoreAllMocks())

describe('Vault Transit data keys', () => {
  it('requests 256 bits with the dev token and rejects redirects', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(datakey())
    const result = await withFetch(fetch).transitDataKey('ws-project_1')
    expect(result).toEqual({ plaintext: keyBytes, ciphertext })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe('http://vault.test:8200/v1/transit/datakey/plaintext/ws-project_1')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: '{"bits":256}' })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(init?.headers).get('x-vault-token')).toBe(options.token)
  })

  it('unwraps the data key through the named workspace Transit key', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ data: { plaintext } }))
    expect(await withFetch(fetch).transitDecryptDataKey('ws-project_1', ciphertext)).toEqual(
      keyBytes,
    )
    expect(fetch.mock.calls[0]?.[0]).toBe('http://vault.test:8200/v1/transit/decrypt/ws-project_1')
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ ciphertext }))
  })

  it.each(['../x', 'ws-a/../b', 'ws-%2f', 'ws-', 'other-1', `ws-${'a'.repeat(65)}`])(
    'refuses unsafe key names before authenticating: %s',
    async (name) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      const store = withFetch(fetch)
      await expect(store.transitDataKey(name)).rejects.toThrow('Invalid Vault workspace key name')
      await expect(store.transitDecryptDataKey(name, ciphertext)).rejects.toThrow(
        'Invalid Vault workspace key name',
      )
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('rejects malformed ciphertext and missing credentials before HTTP', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      withFetch(fetch).transitDecryptDataKey('ws-a', 'private-invalid-input'),
    ).rejects.toThrow('Invalid wrapped Vault data key')
    const store = createVaultSecretStore({ addr: options.addr, fetch })
    await expect(store.transitDataKey('ws-a')).rejects.toThrow('authentication is not configured')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    Buffer.alloc(16).toString('base64'),
    Buffer.alloc(64).toString('base64'),
    `${plaintext}\n`,
    plaintext.slice(0, -1),
    `${'A'.repeat(42)}B=`,
  ])('refuses a wrong-size or noncanonical key', async (invalid) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ data: { plaintext: invalid, ciphertext } }))
      .mockResolvedValueOnce(reply({ data: { plaintext: invalid } }))
    const store = withFetch(fetch)
    await expect(store.transitDataKey('ws-a')).rejects.toThrow(
      'exactly 32 bytes in canonical base64',
    )
    await expect(store.transitDecryptDataKey('ws-a', ciphertext)).rejects.toThrow(
      'exactly 32 bytes in canonical base64',
    )
  })

  it.each([302, 403, 404, 500])(
    'keeps HTTP %i failures free of response secrets',
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(reply({ errors: [`secret:${plaintext}:${options.token}`] }, status))
      const error: unknown = await withFetch(fetch)
        .transitDataKey('ws-a')
        .catch((e: unknown) => e)
      expect(error).toMatchObject({ name: 'VaultError', status })
      expect(inspect(error)).not.toContain(plaintext)
      expect(inspect(error)).not.toContain(options.token)
      expect(error).not.toHaveProperty('cause')
    },
  )

  it('removes a network error cause that contains credentials', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error(`https://user:${options.token}@vault.test ${plaintext}`))
    const error: unknown = await withFetch(fetch)
      .transitDataKey('ws-a')
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'VaultError', message: 'Vault request failed' })
    expect(inspect(error)).not.toContain(options.token)
    expect(inspect(error)).not.toContain(plaintext)
    expect(error).not.toHaveProperty('cause')
  })

  it('does not echo malformed JSON or malformed response fields', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(`not-json-secret:${plaintext}`))
      .mockResolvedValueOnce(reply({ data: { plaintext, ciphertext: 'unexpected-secret' } }))
    const store = withFetch(fetch)
    for (let i = 0; i < 2; i++) {
      const error: unknown = await store.transitDataKey('ws-a').catch((e: unknown) => e)
      expect(error).toMatchObject({ name: 'VaultError' })
      expect(inspect(error)).not.toContain(plaintext)
      expect(inspect(error)).not.toContain('unexpected-secret')
    }
  })

  it('bounds the response size', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('x'.repeat(65_537)))
    await expect(withFetch(fetch).transitDataKey('ws-a')).rejects.toThrow('exceeds the size limit')
  })

  it('times out a request without forwarding the abort cause', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))
        }),
    )
    const store = createVaultSecretStore({ ...options, fetch, timeoutMs: 10 })
    await expect(store.transitDataKey('ws-a')).rejects.toThrow('Vault request timed out')
  })

  it.each([
    'https://user:secret@vault.test',
    'https://vault.test?secret=x',
    'https://vault.test#secret',
    'ftp://vault.test',
  ])('refuses an unsafe base URL without echoing it', (addr) => {
    expect(() => createVaultSecretStore({ ...options, addr })).toThrow('Invalid Vault address')
  })
})

describe('Vault Transit workspace keys', () => {
  const workspaceKey = 'ws-01960000-0000-7000-8000-000000000003'
  const keyReply = (type = 'aes256-gcm96') =>
    reply({ data: { name: workspaceKey, type, latest_version: 1, exportable: false } })

  it('creates the key with its type alone, as the provisioner policy allows', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(keyReply())
    await expect(withFetch(fetch).transitEnsureKey(workspaceKey)).resolves.toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`http://vault.test:8200/v1/transit/keys/${workspaceKey}`)
    expect(init).toMatchObject({
      method: 'POST',
      redirect: 'error',
      body: '{"type":"aes256-gcm96"}',
    })
    expect(new Headers(init?.headers).get('x-vault-token')).toBe(options.token)
  })

  it('takes an existing key as it is: a repeat sends the same creation and nothing else', async () => {
    // Transit answers a creation of an existing key with that key, neither rotated nor changed.
    const fetch = vi.fn<typeof globalThis.fetch>(async () => keyReply())
    const store = withFetch(fetch)
    await store.transitEnsureKey(workspaceKey)
    await store.transitEnsureKey(workspaceKey)
    expect(fetch.mock.calls.map(([url, init]) => [String(url), init?.body])).toEqual([
      [`http://vault.test:8200/v1/transit/keys/${workspaceKey}`, '{"type":"aes256-gcm96"}'],
      [`http://vault.test:8200/v1/transit/keys/${workspaceKey}`, '{"type":"aes256-gcm96"}'],
    ])
  })

  it('accepts an answer without a body, as an older Vault gives', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    await expect(withFetch(fetch).transitEnsureKey(workspaceKey)).resolves.toBeUndefined()
  })

  it.each([
    'ws-project_1',
    'ws-ws1',
    'ws-01960000-0000-7000-8000-00000000000',
    'ws-01960000-0000-7000-8000-00000000000A',
    'WS-01960000-0000-7000-8000-000000000003',
    'other-01960000-0000-7000-8000-000000000003',
    'ws-01960000-0000-7000-8000-000000000003/rotate',
    'ws-01960000-0000-7000-8000-000000000003/config',
    `ws-01960000-0000-7000-8000-000000000003%2fconfig`,
    '../ws-01960000-0000-7000-8000-000000000003',
    'ws-',
  ])('creates nothing but the key of a workspace id, before authenticating: %s', async (name) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(withFetch(fetch).transitEnsureKey(name)).rejects.toThrow(
      'Invalid Vault workspace key name',
    )
    expect(fetch).not.toHaveBeenCalled()
  })

  it('refuses a key of another type under the name of a workspace', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(keyReply('rsa-2048'))
    await expect(withFetch(fetch).transitEnsureKey(workspaceKey)).rejects.toThrow(
      'Vault workspace key has an unexpected type',
    )
  })

  it('refuses an answer that does not describe a key, without echoing it', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ data: { secret: options.token } }))
    const error: unknown = await withFetch(fetch)
      .transitEnsureKey(workspaceKey)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'VaultError', message: 'Unexpected Vault key response' })
    expect(inspect(error)).not.toContain(options.token)
  })

  it.each([400, 403, 500, 503])('fails on HTTP %i with the status alone', async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ errors: [`permission denied ${options.token}`] }, status))
    const error: unknown = await withFetch(fetch)
      .transitEnsureKey(workspaceKey)
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ name: 'VaultError', status })
    expect(inspect(error)).not.toContain(options.token)
    expect(error).not.toHaveProperty('cause')
  })
})

describe('Vault AppRole sessions', () => {
  it('shares one login across concurrent calls and caches the service token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/login') ? loginReply() : datakey(),
    )
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    await Promise.all([store.transitDataKey('ws-a'), store.transitDataKey('ws-b')])
    await store.transitDataKey('ws-c')
    const logins = fetch.mock.calls.filter(([url]) => String(url).endsWith('/login'))
    expect(logins).toHaveLength(1)
    expect(logins[0]?.[1]?.body).toBe(
      JSON.stringify({ role_id: role.roleId, secret_id: role.secretId }),
    )
    expect(new Headers(logins[0]?.[1]?.headers).has('x-vault-token')).toBe(false)
    expect(logins[0]?.[1]?.redirect).toBe('error')
    for (const [, init] of fetch.mock.calls.slice(1)) {
      expect(new Headers(init?.headers).get('x-vault-token')).toBe('service-token')
      expect(init?.body).not.toContain(role.secretId)
    }
  })

  it('reauthenticates before the cached lease expires', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000)
    let logins = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/login') ? loginReply(`token-${++logins}`, 10) : datakey(),
    )
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    await store.transitDataKey('ws-a')
    clock.mockReturnValue(108_999)
    await store.transitDataKey('ws-a')
    expect(logins).toBe(1)
    clock.mockReturnValue(109_000)
    await store.transitDataKey('ws-a')
    expect(logins).toBe(2)
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('x-vault-token')).toBe('token-2')
  })

  it('does not cache zero-TTL tokens indefinitely', async () => {
    let logins = 0
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith('/login') ? loginReply(`token-${++logins}`, 0) : datakey(),
    )
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    await store.transitDataKey('ws-a')
    await store.transitDataKey('ws-a')
    expect(logins).toBe(2)
  })

  it('does not cache a failed login and does not fall back to the root token', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ errors: [role.secretId] }, 403))
      .mockResolvedValueOnce(loginReply())
      .mockResolvedValueOnce(datakey())
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    await expect(store.transitDataKey('ws-a')).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(store.transitDataKey('ws-a')).resolves.toMatchObject({ ciphertext })
    expect(fetch.mock.calls.map(([url]) => String(url).split('/').at(-1))).toEqual([
      'login',
      'login',
      'ws-a',
    ])
  })

  it('invalidates a refused service token without blindly retrying the Transit write', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(loginReply('token-1'))
      .mockResolvedValueOnce(reply({ errors: ['denied'] }, 403))
      .mockResolvedValueOnce(loginReply('token-2'))
      .mockResolvedValueOnce(datakey())
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    await expect(store.transitDataKey('ws-a')).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledTimes(2)
    await store.transitDataKey('ws-a')
    expect(new Headers(fetch.mock.calls.at(-1)?.[1]?.headers).get('x-vault-token')).toBe('token-2')
  })

  it('refuses malformed login metadata without exposing tokens', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ auth: { client_token: options.token, lease_duration: -1 } }))
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    const error: unknown = await store.transitDataKey('ws-a').catch((e: unknown) => e)
    expect(error).toMatchObject({ message: 'Unexpected Vault AppRole response' })
    expect(inspect(error)).not.toContain(options.token)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
