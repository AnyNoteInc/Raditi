import { afterEach, describe, expect, it, vi } from 'vitest'

import { VaultError } from './errors.ts'
import { createVaultSecretStore } from './vault-secret-store.ts'
import { wrappingLimits } from './wrapping.ts'

const address = 'http://vault.test:8200'
const sessionToken = 'private-core-token'
const role = { roleId: 'test-role', secretId: 'private-approle-secret' }
const wrapped = 's.inJPySDTpJLPVNOLGpbanlGP'
const accessor = 'knfpgTqnzXp7Y1KfJUMG4sca'
const data = { apiToken: 'private-release-api-token', dataKey: 'private-backup-key' }
const now = Date.parse('2026-10-17T15:40:31.000Z')

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
// Bodies as OpenBao 2.7.0 answered them on 2026-10-17 (a disposable dev server).
const wrapReply = (ttl = 1800) =>
  reply({
    request_id: '',
    lease_id: '',
    renewable: false,
    lease_duration: 0,
    data: null,
    wrap_info: {
      token: wrapped,
      accessor,
      ttl,
      creation_time: '2026-10-17T15:40:31.008369715Z',
      creation_path: 'sys/wrapping/wrap',
    },
    warnings: null,
    auth: null,
  })
const unwrapReply = () =>
  reply({
    request_id: '48f94a37-df50-d253-da41-95eb89eaa9d2',
    lease_id: '',
    renewable: false,
    lease_duration: 0,
    data,
    wrap_info: null,
    warnings: null,
    auth: null,
  })
const lookupReply = () =>
  reply({
    request_id: '5dc5ba95-98d8-734d-e0dc-ec47fd38da72',
    lease_id: '',
    renewable: false,
    lease_duration: 0,
    data: {
      creation_path: 'sys/wrapping/wrap',
      creation_time: '2026-10-17T15:40:31.008369715Z',
      creation_ttl: 1800,
    },
    wrap_info: null,
    warnings: null,
    auth: null,
  })
const invalid = () => reply({ errors: ['wrapping token is not valid or does not exist'] }, 400)
const denied = () => reply({ errors: ['1 error occurred:\n\t* permission denied\n\n'] }, 403)
const gone = () =>
  reply({
    request_id: '63a86c37-817d-e897-63c9-e84296a1a237',
    lease_id: '',
    renewable: false,
    lease_duration: 0,
    data: null,
    wrap_info: null,
    warnings: ['No token found with this accessor'],
    auth: null,
  })
const login = (value = sessionToken) =>
  reply({ auth: { client_token: value, lease_duration: 600 } })

const store = (fetch: typeof globalThis.fetch, appRole = false) =>
  createVaultSecretStore({
    addr: `${address}/`,
    ...(appRole ? { appRole: role } : { token: sessionToken }),
    fetch,
  })
const sent = (fetch: ReturnType<typeof vi.fn<typeof globalThis.fetch>>, index: number) => {
  const [url, init] = fetch.mock.calls[index]!
  return {
    url,
    method: init?.method,
    token: new Headers(init?.headers).get('x-vault-token'),
    wrapTtl: new Headers(init?.headers).get('x-vault-wrap-ttl'),
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body,
    redirect: init?.redirect,
  }
}
const failure = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.catch((error: unknown) => error)
/** Nothing of the wrapped data, the wrapping token or a credential in a message. */
const quiet = (error: unknown) => {
  expect(error).toBeInstanceOf(VaultError)
  for (const value of [wrapped, sessionToken, role.secretId, ...Object.values(data)])
    expect(String((error as Error).message)).not.toContain(value)
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('SecretStore.wrap', () => {
  it('wraps the data for the asked lifetime with the session token', async () => {
    vi.useFakeTimers({ now, toFake: ['Date'] })
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(wrapReply())
    expect(await store(fetch).wrap(data, 1800)).toEqual({
      token: wrapped,
      accessor,
      expiresAt: new Date(now + 1800 * 1000),
    })
    expect(sent(fetch, 0)).toEqual({
      url: `${address}/v1/sys/wrapping/wrap`,
      method: 'POST',
      token: sessionToken,
      // Without the header the endpoint answers 400 "endpoint requires response wrapping".
      wrapTtl: '1800',
      body: data,
      redirect: 'error',
    })
  })

  it.each([0, -1, 1.5, Number.NaN, wrappingLimits.maxTtlSeconds + 1])(
    'refuses the lifetime %s before any request',
    async (ttl) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      quiet(await failure(store(fetch).wrap(data, ttl)))
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['nothing', {}],
    ['a value that is not text', { key: 1 }],
    ['a nested value', { key: { inner: 'x' } }],
    ['a prototype key', JSON.parse('{"__proto__":"x"}') as Record<string, string>],
  ])('refuses to wrap %s before any request', async (_, value) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    quiet(await failure(store(fetch).wrap(value as Record<string, string>, 600)))
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['another lifetime', wrapReply(60)],
    [
      'an answer of another endpoint',
      reply({
        wrap_info: { token: wrapped, accessor, ttl: 1800, creation_path: 'auth/token/create' },
      }),
    ],
    ['no wrapping', reply({ data, wrap_info: null })],
    [
      'a token that cannot be one',
      reply({
        wrap_info: { token: 'a b', accessor, ttl: 1800, creation_path: 'sys/wrapping/wrap' },
      }),
    ],
  ])('refuses %s without quoting it', async (_, response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response)
    const error = await failure(store(fetch).wrap(data, 1800))
    quiet(error)
    expect((error as Error).message).toBe('Unexpected Vault wrapping response')
  })

  it('passes a refusal of the policy on as the status of Vault', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(denied())
    const error = await failure(store(fetch).wrap(data, 1800))
    quiet(error)
    expect(error).toMatchObject({ status: 403 })
  })
})

describe('SecretStore.unwrap', () => {
  it('opens the wrapping with the wrapping token alone: no login, no session token', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(unwrapReply())
    expect(await store(fetch, true).unwrap(wrapped)).toEqual(data)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(sent(fetch, 0)).toEqual({
      url: `${address}/v1/sys/wrapping/unwrap`,
      method: 'POST',
      token: wrapped,
      wrapTtl: null,
      body: undefined,
      redirect: 'error',
    })
  })

  it('answers null for a spent, revoked or expired wrapping', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(invalid())
    expect(await store(fetch).unwrap(wrapped)).toBeNull()
  })

  it('keeps the session token when the wrapping token is refused', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(lookupReply())
      .mockResolvedValueOnce(denied())
      .mockResolvedValueOnce(lookupReply())
    const vault = store(fetch, true)
    await vault.lookupWrapping(wrapped)
    quiet(await failure(vault.unwrap(wrapped)))
    await vault.lookupWrapping(wrapped)
    // One login: the refusal belonged to the wrapping token, not to the AppRole token.
    expect(fetch.mock.calls.map(([url]) => String(url).slice(address.length))).toEqual([
      '/v1/auth/approle/login',
      '/v1/sys/wrapping/lookup',
      '/v1/sys/wrapping/unwrap',
      '/v1/sys/wrapping/lookup',
    ])
  })

  it.each(['', 'short', 'a b c d e f', `${'x'.repeat(513)}`, 'token\n123'])(
    'refuses the token %j before any request',
    async (value) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      quiet(await failure(store(fetch).unwrap(value)))
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('refuses data of another shape without quoting it', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ data: { nested: { apiToken: data.apiToken } } }))
    const error = await failure(store(fetch).unwrap(wrapped))
    quiet(error)
    expect((error as Error).message).toBe('Unexpected Vault unwrap response')
  })
})

describe('SecretStore.lookupWrapping', () => {
  it('reads when a live wrapping was made and when it ends, without opening it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(lookupReply())
    expect(await store(fetch).lookupWrapping(wrapped)).toEqual({
      creationPath: 'sys/wrapping/wrap',
      createdAt: new Date('2026-10-17T15:40:31.008Z'),
      expiresAt: new Date('2026-10-17T16:10:31.008Z'),
    })
    expect(sent(fetch, 0)).toMatchObject({
      url: `${address}/v1/sys/wrapping/lookup`,
      method: 'POST',
      token: sessionToken,
      body: { token: wrapped },
    })
  })

  it('answers null once the wrapping is spent, revoked or expired', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(invalid())
    expect(await store(fetch).lookupWrapping(wrapped)).toBeNull()
  })

  it('fails on another refusal instead of calling the wrapping gone', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(denied())
    quiet(await failure(store(fetch).lookupWrapping(wrapped)))
  })
})

describe('SecretStore.revokeAccessor', () => {
  it.each([
    ['a live wrapping (204)', () => new Response(null, { status: 204 })],
    ['one that is already gone (200 with a warning)', gone],
  ])('revokes %s', async (_, response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response())
    await expect(store(fetch).revokeAccessor(accessor)).resolves.toBeUndefined()
    expect(sent(fetch, 0)).toMatchObject({
      url: `${address}/v1/auth/token/revoke-accessor`,
      method: 'POST',
      token: sessionToken,
      body: { accessor },
    })
  })

  it('reports a refusal: the wrapping may still be alive', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(denied())
    const error = await failure(store(fetch).revokeAccessor(accessor))
    quiet(error)
    expect(error).toMatchObject({ status: 403 })
  })

  it.each(['', 'acc', 'acc/../x', 'a'.repeat(257)])(
    'refuses the accessor %j before any request',
    async (value) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      quiet(await failure(store(fetch).revokeAccessor(value)))
      expect(fetch).not.toHaveBeenCalled()
    },
  )
})
