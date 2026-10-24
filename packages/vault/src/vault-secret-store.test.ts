import { Buffer } from 'node:buffer'

import { isDomainError } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { VaultError } from './errors.ts'
import { createVaultSecretStore } from './vault-secret-store.ts'

const TOKEN = 'hvs.root-token-never-sent'

const healthBody = (overrides: Record<string, unknown> = {}) => ({
  initialized: true,
  sealed: false,
  standby: false,
  performance_standby: false,
  replication_performance_mode: 'disabled',
  replication_dr_mode: 'disabled',
  server_time_utc: 1_790_000_000,
  version: '2.7.0',
  cluster_name: 'vault-cluster-1',
  cluster_id: 'c-1',
  ...overrides,
})

function fakeFetch(status: number, body: unknown) {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

function storeWith(fetchMock: typeof fetch, timeoutMs?: number) {
  return createVaultSecretStore({
    addr: 'http://vault.test:8200/',
    token: TOKEN,
    appRole: { roleId: 'role', secretId: 'secret' },
    fetch: fetchMock,
    timeoutMs,
  })
}

describe('createVaultSecretStore().health', () => {
  it('calls the unauthenticated health endpoint with standby tolerance and a timeout', async () => {
    const fetchMock = fakeFetch(200, healthBody())

    await storeWith(fetchMock).health()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('http://vault.test:8200/v1/sys/health?standbyok=true&perfstandbyok=true')
    expect(init?.method).toBe('GET')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(init?.headers)
    expect(headers.has('x-vault-token')).toBe(false)
    expect(JSON.stringify(init)).not.toContain(TOKEN)
  })

  it('maps 200 to an active, unsealed node', async () => {
    expect(await storeWith(fakeFetch(200, healthBody())).health()).toEqual({
      initialized: true,
      sealed: false,
      standby: false,
      version: '2.7.0',
    })
  })

  it('reports standby from the body when standbyok turned 429 into 200', async () => {
    const health = await storeWith(fakeFetch(200, healthBody({ standby: true }))).health()
    expect(health.standby).toBe(true)
  })

  it.each([429, 472, 473])('maps %i to a standby node', async (status) => {
    const health = await storeWith(fakeFetch(status, healthBody())).health()
    expect(health).toMatchObject({ initialized: true, sealed: false, standby: true })
  })

  it('maps a performance standby from the body', async () => {
    const health = await storeWith(
      fakeFetch(200, healthBody({ performance_standby: true })),
    ).health()
    expect(health.standby).toBe(true)
  })

  it('maps 501 to not initialized (and therefore sealed)', async () => {
    const health = await storeWith(
      fakeFetch(501, healthBody({ initialized: false, sealed: true, standby: true })),
    ).health()
    expect(health).toMatchObject({ initialized: false, sealed: true })
  })

  it('maps 503 to sealed even if the body disagrees', async () => {
    const health = await storeWith(fakeFetch(503, healthBody({ sealed: false }))).health()
    expect(health).toMatchObject({ initialized: true, sealed: true })
  })

  it('tolerates a missing version', async () => {
    const { version: _omit, ...body } = healthBody()
    const health = await storeWith(fakeFetch(200, body)).health()
    expect(health.version).toBe('')
  })

  it('throws VaultError on an unexpected status', async () => {
    await expect(storeWith(fakeFetch(500, { errors: [] })).health()).rejects.toMatchObject({
      name: 'VaultError',
      status: 500,
    })
  })

  it('throws VaultError on a body that is not JSON', async () => {
    await expect(storeWith(fakeFetch(200, '<html>proxy</html>')).health()).rejects.toBeInstanceOf(
      VaultError,
    )
  })

  it('throws VaultError on a body of the wrong shape', async () => {
    await expect(storeWith(fakeFetch(200, { sealed: 'no' })).health()).rejects.toThrow(
      /Unexpected Vault health response body/,
    )
  })

  it('throws VaultError on network errors without leaking the token', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
    const error = await storeWith(fetchMock)
      .health()
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VaultError)
    expect((error as Error).message).toBe('Vault health request failed')
    expect((error as Error).message).not.toContain(TOKEN)
  })

  it('gives up after the timeout', async () => {
    const hanging = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))
        }),
    )
    await expect(storeWith(hanging, 20).health()).rejects.toThrow('Vault health request timed out')
  })
})

describe('createVaultSecretStore().health with KV mounts in use', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  /** A router over the mounts that exist right now; the token sees every one of them. */
  function vault(mounts: Set<string>, health: () => Response = () => json(200, healthBody())) {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname.slice('/v1/'.length)
      if (path === 'sys/health') return health()
      if (path === 'auth/approle/login')
        return json(200, { auth: { client_token: 'role-token', lease_duration: 3600 } })
      const [mount = ''] = path.split('/')
      if (path.startsWith('sys/internal/ui/mounts/')) {
        return mounts.has(path.split('/')[4] ?? '')
          ? json(200, { data: { type: 'kv', options: { version: '2' } } })
          : json(403, { errors: ['preflight capability check returned 403'] })
      }
      if (!mounts.has(mount)) return json(404, { errors: ['no handler for route'] })
      return init?.method === 'LIST'
        ? json(200, { data: { keys: ['t_a'] } })
        : json(404, { errors: [] })
    })
    return { fetchMock, store: storeWith(fetchMock) }
  }
  const paths = (fetchMock: ReturnType<typeof vault>['fetchMock']) =>
    fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname.slice('/v1/'.length))

  it('fails while a mount this process works with is gone and recovers when it is back', async () => {
    const mounts = new Set(['turns'])
    const { fetchMock, store } = vault(mounts)
    expect(await store.kvList('turns/')).toEqual(['t_a'])
    expect(await store.health()).toMatchObject({ initialized: true, sealed: false })
    expect(paths(fetchMock).slice(-2)).toEqual(['sys/health', 'sys/internal/ui/mounts/turns'])
    const [, probe] = fetchMock.mock.calls.at(-1)!
    expect(new Headers(probe?.headers).get('x-vault-token')).toBe('role-token')

    // An in-memory dev server came back empty: reads look like "no keys", not like an error.
    mounts.clear()
    expect(await store.kvList('turns/')).toEqual([])
    await expect(store.health()).rejects.toThrow('Vault KV mount turns/ is not available')

    mounts.add('turns')
    expect(await store.health()).toMatchObject({ initialized: true, sealed: false })
  })

  it('reports a mount that never existed after the first attempt to use it', async () => {
    const { store } = vault(new Set())
    expect(await store.health()).toMatchObject({ initialized: true, sealed: false })
    expect(await store.kvRead('subs/zai-coding/account_1')).toBeNull()
    const error = await store.health().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VaultError)
    expect((error as Error).message).toBe('Vault KV mount subs/ is not available')
  })

  it('does not log in again for every failed mount probe', async () => {
    const { fetchMock, store } = vault(new Set())
    expect(await store.kvRead('subs/zai-coding/account_1')).toBeNull()
    for (let probe = 0; probe < 3; probe += 1) await expect(store.health()).rejects.toThrow()
    expect(paths(fetchMock).filter((path) => path === 'auth/approle/login')).toHaveLength(1)
  })

  it('leaves the mounts of a sealed node alone', async () => {
    const { fetchMock, store } = vault(new Set(), () => json(503, healthBody({ sealed: true })))
    expect(await store.kvRead('subs/zai-coding/account_1')).toBeNull()
    expect(await store.health()).toMatchObject({ sealed: true })
    expect(paths(fetchMock).some((path) => path.startsWith('sys/internal/'))).toBe(false)
  })

  it('does not track a path that was rejected before any request', async () => {
    const { fetchMock, store } = vault(new Set())
    await expect(store.kvRead('subs/../x')).rejects.toBeInstanceOf(VaultError)
    await store.health()
    expect(paths(fetchMock)).toEqual(['sys/health'])
  })
})

describe('createVaultSecretStore().health with Transit in use', () => {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const plaintext = Buffer.alloc(32, 7).toString('base64')
  const ciphertext = `vault:v1:${Buffer.alloc(60, 9).toString('base64')}`

  /** `visible` is what the token can use right now: a mount that is gone or a lost policy. */
  function vault(visible: Set<string>) {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const path = new URL(String(url)).pathname.slice('/v1/'.length)
      if (path === 'sys/health') return json(200, healthBody())
      if (path === 'auth/approle/login')
        return json(200, { auth: { client_token: 'role-token', lease_duration: 3600 } })
      if (path.startsWith('sys/internal/ui/mounts/')) {
        return visible.has(path.split('/')[4] ?? '')
          ? json(200, { data: { type: path.endsWith('/transit') ? 'transit' : 'kv' } })
          : json(403, { errors: ['preflight capability check returned 403'] })
      }
      if (!visible.has(path.split('/')[0] ?? ''))
        return json(404, { errors: ['no handler for route'] })
      if (path.startsWith('transit/datakey/plaintext/'))
        return json(200, { data: { plaintext, ciphertext } })
      if (path.startsWith('transit/decrypt/')) return json(200, { data: { plaintext } })
      if (path.startsWith('transit/keys/')) return json(200, { data: { type: 'aes256-gcm96' } })
      return json(404, { errors: [] })
    })
    return { fetchMock, store: storeWith(fetchMock) }
  }
  const paths = (fetchMock: ReturnType<typeof vault>['fetchMock']) =>
    fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname.slice('/v1/'.length))

  it('leaves Transit alone until the process has asked it for a key', async () => {
    const { fetchMock, store } = vault(new Set())
    expect(await store.health()).toMatchObject({ initialized: true, sealed: false })
    expect(paths(fetchMock)).toEqual(['sys/health'])
  })

  it.each([
    ['a data key', (store: ReturnType<typeof storeWith>) => store.transitDataKey('ws-a')],
    [
      'an unwrapped key',
      (store: ReturnType<typeof storeWith>) => store.transitDecryptDataKey('ws-a', ciphertext),
    ],
    [
      'a new workspace key',
      (store: ReturnType<typeof storeWith>) =>
        store.transitEnsureKey('ws-01960000-0000-7000-8000-000000000003'),
    ],
  ])('fails while Transit is gone after %s and recovers when it is back', async (_name, use) => {
    const visible = new Set(['transit'])
    const { fetchMock, store } = vault(visible)
    await use(store)
    expect(await store.health()).toMatchObject({ initialized: true, sealed: false })
    expect(paths(fetchMock).slice(-2)).toEqual(['sys/health', 'sys/internal/ui/mounts/transit'])
    const [, probe] = fetchMock.mock.calls.at(-1)!
    expect(new Headers(probe?.headers).get('x-vault-token')).toBe('role-token')

    visible.clear()
    const error = await store.health().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(VaultError)
    expect((error as Error).message).toBe('Vault Transit mount transit/ is not available')
    expect((error as VaultError).status).toBe(403)

    visible.add('transit')
    expect(await store.health()).toMatchObject({ initialized: true, sealed: false })
    expect(paths(fetchMock).filter((path) => path === 'auth/approle/login')).toHaveLength(1)
  })

  it('reports Transit after the first refused request for a key', async () => {
    const { store } = vault(new Set())
    await expect(store.transitDataKey('ws-a')).rejects.toMatchObject({ status: 404 })
    await expect(store.health()).rejects.toThrow('Vault Transit mount transit/ is not available')
  })

  it('probes Transit next to the KV mounts the process works with', async () => {
    const visible = new Set(['transit', 'kv'])
    const { fetchMock, store } = vault(visible)
    expect(await store.kvRead('kv/content-masks/site/task')).toBeNull()
    await store.transitDataKey('ws-a')
    await store.health()
    expect(paths(fetchMock).slice(-3).sort()).toEqual([
      'sys/health',
      'sys/internal/ui/mounts/kv',
      'sys/internal/ui/mounts/transit',
    ])
    visible.delete('transit')
    await expect(store.health()).rejects.toThrow('Vault Transit mount transit/ is not available')
    visible.add('transit').delete('kv')
    await expect(store.health()).rejects.toThrow('Vault KV mount kv/ is not available')
  })

  it('does not track a key name or a wrapped key refused before any request', async () => {
    const { fetchMock, store } = vault(new Set())
    await expect(store.transitDataKey('other-key')).rejects.toBeInstanceOf(VaultError)
    await expect(store.transitDecryptDataKey('ws-a', 'not-wrapped')).rejects.toBeInstanceOf(
      VaultError,
    )
    await store.health()
    expect(paths(fetchMock)).toEqual(['sys/health'])
  })
})

describe('createVaultSecretStore() methods planned for P7', () => {
  const store = storeWith(fakeFetch(200, healthBody()))

  it.each([
    ['sshSign', () => store.sshSign('deploy', 'ssh-ed25519 AAAA', 900)],
    ['createToken', () => store.createToken(['site-1-deploy'], 900)],
  ])('%s rejects with NOT_IMPLEMENTED', async (method, call) => {
    const error = await call().catch((e: unknown) => e)
    expect(isDomainError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'NOT_IMPLEMENTED' })
    expect((error as Error).message).toContain(`${method} (P7)`)
  })
})
