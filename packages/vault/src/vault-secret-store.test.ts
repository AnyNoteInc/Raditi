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

describe('createVaultSecretStore() methods planned for P7', () => {
  const store = storeWith(fakeFetch(200, healthBody()))

  it.each([
    ['kvRead', () => store.kvRead('kv/sites/1/ssh')],
    ['kvWrite', () => store.kvWrite('kv/sites/1/ssh', { key: 'value' })],
    ['kvDelete', () => store.kvDelete('kv/sites/1/ssh')],
    ['sshSign', () => store.sshSign('deploy', 'ssh-ed25519 AAAA', 900)],
    ['createToken', () => store.createToken(['site-1-deploy'], 900)],
    ['wrap', () => store.wrap({ token: 'x' }, 600)],
    ['revokeAccessor', () => store.revokeAccessor('acc-1')],
  ])('%s rejects with NOT_IMPLEMENTED', async (method, call) => {
    const error = await call().catch((e: unknown) => e)
    expect(isDomainError(error)).toBe(true)
    expect(error).toMatchObject({ code: 'NOT_IMPLEMENTED' })
    expect((error as Error).message).toContain(`${method} (P7)`)
  })
})
