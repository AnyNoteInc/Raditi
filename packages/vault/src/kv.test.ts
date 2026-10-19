import { Buffer } from 'node:buffer'
import { inspect } from 'node:util'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { VaultError } from './errors.ts'
import { createVaultSecretStore } from './vault-secret-store.ts'

const address = 'http://vault.test:8200'
const secret = 'private-kv-credential'
const token = 'private-vault-token'
const options = { addr: `${address}/`, token }
const role = { roleId: 'test-role', secretId: 'private-approle-secret' }
const createdTime = '2026-09-30T12:00:00.000Z'
const now = new Date('2026-09-30T12:05:00.000Z').getTime()
const credential = { v: '1', accessToken: secret, refreshToken: 'private-refresh-token' }
const custom = { sessionId: 'session-test', validUntil: '2026-09-30T12:20:00.000Z' }

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const empty = () => new Response(null, { status: 204 })
const written = (version = 1) =>
  reply({ data: { version, created_time: createdTime, deletion_time: '', destroyed: false } })
const read = (version = 1) =>
  reply({
    data: {
      data: credential,
      metadata: { version, created_time: createdTime, deletion_time: '', destroyed: false },
    },
  })
const metadataBody = (
  version = 1,
  changes: { deletion_time?: string; destroyed?: boolean; created_time?: string } = {},
) => ({
  data: {
    current_version: version,
    oldest_version: version,
    created_time: createdTime,
    updated_time: createdTime,
    custom_metadata: custom,
    versions: {
      [String(version)]: {
        created_time: createdTime,
        deletion_time: '',
        destroyed: false,
        ...changes,
      },
    },
  },
})
const login = (value = 'role-token') => reply({ auth: { client_token: value, lease_duration: 60 } })
const withFetch = (fetch: typeof globalThis.fetch) => createVaultSecretStore({ ...options, fetch })
const failure = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.catch((error: unknown) => error)

afterEach(() => vi.restoreAllMocks())

describe('Vault KV v2 requests', () => {
  it('reads data and its CAS version together from the selected mount', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(read(7))
    expect(await withFetch(fetch).kvRead('subs/zai-coding/account_1')).toEqual({
      data: credential,
      version: 7,
    })
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${address}/v1/subs/data/zai-coding/account_1`)
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' })
    expect(init?.body).toBeUndefined()
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(new Headers(init?.headers).get('x-vault-token')).toBe(token)
    expect(new Headers(init?.headers).get('accept')).toBe('application/json')
  })

  it.each([0, 1, 7])(
    'sends CAS %i without converting it into an unconditional write',
    async (cas) => {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(written(cas + 1))
      expect(
        await withFetch(fetch).kvWrite('subs/zai-coding/account_1', credential, { cas }),
      ).toEqual({ version: cas + 1 })
      const [url, init] = fetch.mock.calls[0]!
      expect(url).toBe(`${address}/v1/subs/data/zai-coding/account_1`)
      expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
      expect(JSON.parse(String(init?.body))).toEqual({ options: { cas }, data: credential })
      expect(new Headers(init?.headers).get('content-type')).toBe('application/json')
      expect(new Headers(init?.headers).get('x-vault-token')).toBe(token)
    },
  )

  it('allows a generic KV write without CAS for mounts whose policy permits it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(written(4))
    expect(await withFetch(fetch).kvWrite('kv/sites/site_1/wp', { password: secret })).toEqual({
      version: 4,
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(`${address}/v1/kv/data/sites/site_1/wp`)
    const body = JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)) as {
      data: Record<string, string>
      options?: { cas?: number }
    }
    expect(body.data).toEqual({ password: secret })
    expect(body.options?.cas).toBeUndefined()
  })

  it('uses DELETE data for soft deletion and DELETE metadata for all-version destruction', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(empty())
    const store = withFetch(fetch)
    await store.kvDelete('turns/t_task_1_1')
    await store.kvDestroyAll('subs/zai-coding/account_1')
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${address}/v1/turns/data/t_task_1_1`, 'DELETE'],
      [`${address}/v1/subs/metadata/zai-coding/account_1`, 'DELETE'],
    ])
    expect(fetch.mock.calls.every(([, init]) => init?.body === undefined)).toBe(true)
  })

  it('does not try to provision a missing mount or retry a rejected CAS write', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ errors: ['check-and-set parameter did not match'] }, 400))
    await expect(
      withFetch(fetch).kvWrite('subs/zai-coding/account_1', credential, { cas: 3 }),
    ).rejects.toMatchObject({ name: 'VaultError', status: 400 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('Vault write-once turn credentials', () => {
  it('creates data with CAS zero before writing custom metadata', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(written())
      .mockResolvedValueOnce(empty())
    expect(await withFetch(fetch).kvCreateOnce('turns/t_task_1_1', credential, custom)).toBe(
      'created',
    )
    expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
      [`${address}/v1/turns/data/t_task_1_1`, 'POST'],
      [`${address}/v1/turns/metadata/t_task_1_1`, 'POST'],
    ])
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      options: { cas: 0 },
      data: credential,
    })
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ custom_metadata: custom })
  })

  it.each([400, 403])(
    'recovers a live existing write after HTTP %i and repeats metadata',
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(reply({ errors: ['create refused'] }, status))
        .mockResolvedValueOnce(read(1))
        .mockResolvedValueOnce(empty())
      expect(await withFetch(fetch).kvCreateOnce('turns/t_task_1_1', credential, custom)).toBe(
        'exists',
      )
      expect(fetch.mock.calls.map(([url, init]) => [url, init?.method])).toEqual([
        [`${address}/v1/turns/data/t_task_1_1`, 'POST'],
        [`${address}/v1/turns/data/t_task_1_1`, 'GET'],
        [`${address}/v1/turns/metadata/t_task_1_1`, 'POST'],
      ])
    },
  )

  it.each([400, 403])('does not resurrect a tombstone after HTTP %i', async (status) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ errors: ['create refused'] }, status))
      .mockResolvedValueOnce(
        reply(
          {
            data: {
              data: null,
              metadata: { version: 1, deletion_time: createdTime, destroyed: false },
            },
          },
          404,
        ),
      )
    await expect(
      withFetch(fetch).kvCreateOnce('turns/t_task_1_1', credential, custom),
    ).rejects.toBeInstanceOf(VaultError)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1]?.[1]?.method).toBe('GET')
  })

  it('propagates a failed metadata write, allowing a later idempotent retry to repair it', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(written())
      .mockResolvedValueOnce(reply({ errors: ['temporary failure'] }, 503))
      .mockResolvedValueOnce(reply({ errors: ['existing data is not create'] }, 403))
      .mockResolvedValueOnce(read())
      .mockResolvedValueOnce(empty())
    const store = withFetch(fetch)
    await expect(store.kvCreateOnce('turns/t_task_1_1', credential, custom)).rejects.toMatchObject({
      status: 503,
    })
    expect(await store.kvCreateOnce('turns/t_task_1_1', credential, custom)).toBe('exists')
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'GET')).toHaveLength(1)
    expect(fetch.mock.calls.filter(([url]) => String(url).includes('/metadata/'))).toHaveLength(2)
  })

  it('does not reinterpret an arbitrary server failure as an existing credential', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply({}, 500))
    await expect(
      withFetch(fetch).kvCreateOnce('turns/t_task_1_1', credential, custom),
    ).rejects.toMatchObject({ status: 500 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  // KV v2 answers HTTP 400 to such custom metadata: by then the secret would already exist.
  it.each([
    ['65 keys', Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`key_${i}`, 'x']))],
    ['a value of 513 bytes', { sessionId: 'x'.repeat(513) }],
    ['a value of 257 two-byte characters', { sessionId: 'я'.repeat(257) }],
    ['an empty value', { sessionId: '' }],
    ['a line break', { sessionId: 'session\ntest' }],
    ['a tab', { sessionId: 'session\ttest' }],
    ['a no-break space', { sessionId: 'session\u00a0test' }],
    ['a format character', { sessionId: 'session\u200dtest' }],
    ['a private-use character', { sessionId: '\ue000' }],
    ['a lone surrogate', { sessionId: '\ud800' }],
    ['a key of 65 two-byte characters', { ['я'.repeat(65)]: 'x' }],
    ['a key with a control character', { 'session\u0000Id': 'x' }],
  ])('refuses custom metadata with %s before the secret is written', async (_name, metadata) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      withFetch(fetch).kvCreateOnce('turns/t_task_1_1', credential, metadata),
    ).rejects.toThrow('Invalid Vault KV custom metadata')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    [
      '64 keys of 512 bytes',
      Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`key_${i}`, 'x'.repeat(512)])),
    ],
    ['256 two-byte characters', { sessionId: 'я'.repeat(256) }],
    ['a key of 128 bytes', { ['k'.repeat(128)]: 'x' }],
    ['spaces, symbols and combining marks', { 'session id': 'e\u0301 + \u{1F600} = ok' }],
    ['no keys', {}],
  ])('sends custom metadata with %s, which the server accepts', async (_name, metadata) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(written())
      .mockResolvedValueOnce(empty())
    expect(await withFetch(fetch).kvCreateOnce('turns/t_task_1_1', credential, metadata)).toBe(
      'created',
    )
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({
      custom_metadata: metadata,
    })
  })
})

describe('Vault metadata and listing', () => {
  it.each([
    ['', false, false],
    ['2026-09-30T12:20:00.000Z', false, false],
    ['2026-09-30T12:04:59.000Z', false, true],
    ['', true, true],
  ] as const)(
    'only returns live data when deletion time is %s and destroyed is %s',
    async (deletionTime, destroyed, missing) => {
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
        reply({
          data: {
            data: credential,
            metadata: { version: 3, deletion_time: deletionTime, destroyed },
          },
        }),
      )
      expect(await withFetch(fetch).kvRead('turns/t_task_1_1')).toEqual(
        missing ? null : { data: credential, version: 3 },
      )
    },
  )

  it('returns the current version and custom metadata without reading credential data', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply(metadataBody(3)))
    expect(await withFetch(fetch).kvMetadata('subs/zai-coding/account_1')).toEqual({
      currentVersion: 3,
      custom,
      createdTime: new Date(createdTime),
      deleted: false,
      destroyed: false,
    })
    expect(fetch.mock.calls[0]?.[0]).toBe(`${address}/v1/subs/metadata/zai-coding/account_1`)
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('GET')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['2026-09-30T12:20:00.000Z', false],
    ['2026-09-30T12:05:00.000Z', true],
    ['2026-09-30T12:04:59.000Z', true],
    ['', false],
  ] as const)(
    'evaluates scheduled deletion time %s against the current clock',
    async (deletionTime, deleted) => {
      vi.spyOn(Date, 'now').mockReturnValue(now)
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(reply(metadataBody(2, { deletion_time: deletionTime })))
      expect(await withFetch(fetch).kvMetadata('turns/t_task_1_1')).toMatchObject({
        currentVersion: 2,
        deleted,
        destroyed: false,
      })
    },
  )

  it('reports a destroyed current version separately', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply(metadataBody(2, { destroyed: true })))
    expect(await withFetch(fetch).kvMetadata('subs/zai-coding/account_1')).toMatchObject({
      currentVersion: 2,
      destroyed: true,
    })
  })

  it('treats metadata without a data version as deleted', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(
      reply({
        data: {
          ...metadataBody().data,
          current_version: 0,
          oldest_version: 0,
          versions: {},
        },
      }),
    )
    expect(await withFetch(fetch).kvMetadata('turns/t_task_1_1')).toEqual({
      currentVersion: 0,
      custom,
      createdTime: new Date(createdTime),
      deleted: true,
      destroyed: false,
    })
  })

  it('normalizes absent custom metadata to an empty object', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ data: { ...metadataBody().data, custom_metadata: null } }))
    expect(await withFetch(fetch).kvMetadata('subs/zai-coding/account_1')).toMatchObject({
      currentVersion: 1,
      custom: {},
      deleted: false,
    })
  })

  it.each(['read', 'metadata', 'list'] as const)(
    'maps a missing %s response to an empty result',
    async (method) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(reply({ errors: [] }, 404))
      const store = withFetch(fetch)
      const result =
        method === 'read'
          ? await store.kvRead('turns/t_task_1_1')
          : method === 'metadata'
            ? await store.kvMetadata('turns/t_task_1_1')
            : await store.kvList('turns/')
      expect(result).toEqual(method === 'list' ? [] : null)
    },
  )

  it('lists mount metadata in stable order and applies an exclusive cursor before the limit', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ data: { keys: ['t_c', 't_a', 'folder/', 't_b'] } }))
    expect(await withFetch(fetch).kvList('turns/', { after: 't_a', limit: 2 })).toEqual([
      't_b',
      't_c',
    ])
    expect(fetch.mock.calls[0]?.[0]).toBe(`${address}/v1/turns/metadata`)
    expect(fetch.mock.calls[0]?.[1]?.method).toBe('LIST')
  })

  it('supports a nested metadata prefix without traversing credential data', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ data: { keys: ['account_2', 'account_1'] } }))
    expect(await withFetch(fetch).kvList('subs/zai-coding/')).toEqual(['account_1', 'account_2'])
    expect(fetch.mock.calls[0]?.[0]).toBe(`${address}/v1/subs/metadata/zai-coding`)
  })
})

describe('Vault boundary validation', () => {
  it.each([
    '',
    'turns',
    '/turns/a',
    'turns/a/',
    'turns//a',
    'turns/.',
    'turns/..',
    'turns/a/../b',
    'turns/%2e%2e',
    'turns/%2f',
    'turns/a?version=1',
    'turns/a#fragment',
    'turns/a\\b',
    'turns/a b',
    'turns/a\nb',
    `turns/${'a'.repeat(1024)}`,
  ])(
    'rejects unsafe path %j before AppRole login for every data/metadata operation',
    async (path) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      const store = createVaultSecretStore({ addr: address, appRole: role, fetch })
      for (const operation of [
        () => store.kvRead(path),
        () => store.kvWrite(path, credential, { cas: 0 }),
        () => store.kvCreateOnce(path, credential, custom),
        () => store.kvDelete(path),
        () => store.kvDestroyAll(path),
        () => store.kvMetadata(path),
      ]) {
        await expect(operation()).rejects.toBeInstanceOf(VaultError)
      }
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('refuses accessor properties without invoking a secret-bearing getter', async () => {
    const getter = vi.fn(() => {
      throw new Error(`${secret}:${token}`)
    })
    const data = Object.defineProperty({}, 'accessToken', {
      enumerable: true,
      get: getter,
    }) as Record<string, string>
    const fetch = vi.fn<typeof globalThis.fetch>()
    const store = createVaultSecretStore({ addr: address, appRole: role, fetch })
    const error = await failure(store.kvWrite('subs/zai-coding/account_1', data, { cas: 0 }))
    expect(error).toBeInstanceOf(VaultError)
    expect(inspect(error)).not.toContain(secret)
    expect(inspect(error)).not.toContain(token)
    expect(getter).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid CAS %s before authenticating',
    async (cas) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      const store = createVaultSecretStore({ addr: address, appRole: role, fetch })
      await expect(
        store.kvWrite('subs/zai-coding/account_1', credential, { cas }),
      ).rejects.toBeInstanceOf(VaultError)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    { accessToken: 42 },
    { accessToken: null },
    { accessToken: { nested: secret } },
    { accessToken: 'a'.repeat(32769) },
    { '': secret },
    { ['a'.repeat(129)]: secret },
    { constructor: secret },
    { prototype: secret },
    Object.fromEntries([['__proto__', secret]]),
  ])('rejects unsafe secret and custom-metadata records before authenticating', async (data) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const store = createVaultSecretStore({ addr: address, appRole: role, fetch })
    const invalid = data as unknown as Record<string, string>
    await expect(
      store.kvWrite('subs/zai-coding/account_1', invalid, { cas: 0 }),
    ).rejects.toBeInstanceOf(VaultError)
    await expect(
      store.kvCreateOnce('turns/t_task_1_1', credential, invalid),
    ).rejects.toBeInstanceOf(VaultError)
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1001, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid LIST limit %s before authenticating',
    async (limit) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      const store = createVaultSecretStore({ addr: address, appRole: role, fetch })
      await expect(store.kvList('turns/', { limit })).rejects.toBeInstanceOf(VaultError)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it.each([
    { data: { data: credential, metadata: { version: 0 } } },
    { data: { data: credential, metadata: { version: 1.5 } } },
    { data: { data: credential, metadata: { version: '1' } } },
    { data: { data: { accessToken: 42 }, metadata: { version: 1 } } },
    { data: { data: null, metadata: { version: 1 } } },
    { data: credential },
  ])('rejects malformed successful reads without interpreting them as missing', async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply(body))
    await expect(withFetch(fetch).kvRead('subs/zai-coding/account_1')).rejects.toBeInstanceOf(
      VaultError,
    )
  })

  it.each([0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1])(
    'rejects malformed write version %s',
    async (version) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(reply({ data: { version } }))
      await expect(
        withFetch(fetch).kvWrite('subs/zai-coding/account_1', credential, { cas: 0 }),
      ).rejects.toBeInstanceOf(VaultError)
    },
  )

  it.each([
    { data: { current_version: -1 } },
    { data: { ...metadataBody().data, created_time: 'not-a-date' } },
    { data: { ...metadataBody().data, created_time: '2026-02-30T12:00:00Z' } },
    { data: { ...metadataBody().data, versions: {} } },
    metadataBody(1, { deletion_time: 'private-invalid-date' }),
  ])('rejects malformed metadata instead of returning usable state', async (body) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(reply(body))
    await expect(withFetch(fetch).kvMetadata('turns/t_task_1_1')).rejects.toBeInstanceOf(VaultError)
  })

  it.each(['__proto__', 'constructor', 'prototype'])(
    'rejects forbidden response key %s in data and custom metadata',
    async (key) => {
      const unsafe = Object.fromEntries([[key, secret]])
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(reply({ data: { data: unsafe, metadata: { version: 1 } } }))
        .mockResolvedValueOnce(reply({ data: { ...metadataBody().data, custom_metadata: unsafe } }))
      const store = withFetch(fetch)
      for (const promise of [
        store.kvRead('subs/zai-coding/account_1'),
        store.kvMetadata('subs/zai-coding/account_1'),
      ]) {
        const error = await failure(promise)
        expect(error).toBeInstanceOf(VaultError)
        expect(inspect(error)).not.toContain(secret)
        expect(error).not.toHaveProperty('cause')
      }
    },
  )
})

describe('Vault response and credential safety', () => {
  it.each([302, 403, 429, 500])(
    'preserves HTTP %i while discarding secret response bodies',
    async (status) => {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(reply({ errors: [`${secret}:${token}:${role.secretId}`] }, status))
      const error = await failure(withFetch(fetch).kvRead('subs/zai-coding/account_1'))
      expect(error).toMatchObject({ name: 'VaultError', status })
      expect(inspect(error)).not.toContain(secret)
      expect(inspect(error)).not.toContain(token)
      expect(inspect(error)).not.toContain(role.secretId)
      expect(error).not.toHaveProperty('cause')
      expect(fetch).toHaveBeenCalledTimes(1)
    },
  )

  it('does not retry an ambiguous write or expose a network error cause', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error(`${secret}:${token}:${role.secretId}`))
    const error = await failure(
      withFetch(fetch).kvWrite('subs/zai-coding/account_1', credential, { cas: 2 }),
    )
    expect(error).toBeInstanceOf(VaultError)
    expect(inspect(error)).not.toContain(secret)
    expect(inspect(error)).not.toContain(token)
    expect(inspect(error)).not.toContain(role.secretId)
    expect(error).not.toHaveProperty('cause')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    () => new Response(`{"private":"${secret}",`, { status: 200 }),
    () => new Response(new Uint8Array([0xff, 0xfe]), { status: 200 }),
    () => new Response(' '.repeat(1024 * 1024 + 1), { status: 200 }),
  ])('rejects invalid, oversized or non-UTF8 bodies without exposing input', async (response) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(response())
    const error = await failure(withFetch(fetch).kvRead('subs/zai-coding/account_1'))
    expect(error).toBeInstanceOf(VaultError)
    expect(inspect(error)).not.toContain(secret)
    expect(error).not.toHaveProperty('cause')
  })

  it('times out an in-flight KV request without replaying it', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason as Error))
        }),
    )
    const store = createVaultSecretStore({ ...options, fetch, timeoutMs: 10 })
    await expect(
      store.kvWrite('subs/zai-coding/account_1', credential, { cas: 1 }),
    ).rejects.toBeInstanceOf(VaultError)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('shares one AppRole lease across KV and Transit requests', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(login())
      .mockResolvedValueOnce(read())
      .mockResolvedValueOnce(
        reply({
          data: {
            plaintext: Buffer.alloc(32, 23).toString('base64'),
            ciphertext: `vault:v1:${Buffer.alloc(60, 42).toString('base64')}`,
          },
        }),
      )
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    await store.kvRead('subs/zai-coding/account_1')
    await store.transitDataKey('ws-test')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${address}/v1/auth/approle/login`,
      `${address}/v1/subs/data/zai-coding/account_1`,
      `${address}/v1/transit/datakey/plaintext/ws-test`,
    ])
    for (const [, init] of fetch.mock.calls.slice(1)) {
      expect(new Headers(init?.headers).get('x-vault-token')).toBe('role-token')
    }
  })

  it('invalidates a forbidden AppRole lease for the next operation without replaying the write', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(login('first-role-token'))
      .mockResolvedValueOnce(reply({ errors: ['forbidden'] }, 403))
      .mockResolvedValueOnce(login('second-role-token'))
      .mockResolvedValueOnce(read())
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    await expect(
      store.kvWrite('subs/zai-coding/account_1', credential, { cas: 2 }),
    ).rejects.toMatchObject({ status: 403 })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(await store.kvRead('subs/zai-coding/account_1')).toMatchObject({ version: 1 })
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      'POST',
      'POST',
      'POST',
      'GET',
    ])
    expect(new Headers(fetch.mock.calls[3]?.[1]?.headers).get('x-vault-token')).toBe(
      'second-role-token',
    )
  })

  it('keeps the AppRole lease when write-once is refused for a key that already exists', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(login('first-role-token'))
    for (let attempt = 0; attempt < 3; attempt += 1)
      fetch
        .mockResolvedValueOnce(reply({ errors: ['permission denied'] }, 403))
        .mockResolvedValueOnce(read())
        .mockResolvedValueOnce(empty())
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    for (let attempt = 0; attempt < 3; attempt += 1)
      expect(await store.kvCreateOnce('turns/t_task_1_1', credential, custom)).toBe('exists')
    expect(fetch.mock.calls.map(([url]) => String(url).split('/v1/')[1])).toEqual([
      'auth/approle/login',
      ...Array.from({ length: 3 }, () => [
        'turns/data/t_task_1_1',
        'turns/data/t_task_1_1',
        'turns/metadata/t_task_1_1',
      ]).flat(),
    ])
    for (const [, init] of fetch.mock.calls.slice(1))
      expect(new Headers(init?.headers).get('x-vault-token')).toBe('first-role-token')
  })

  it('still replaces a revoked AppRole lease after a refused write-once', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(login('first-role-token'))
      .mockResolvedValueOnce(reply({ errors: ['permission denied'] }, 403))
      // The follow-up read proves whether the token itself is still accepted.
      .mockResolvedValueOnce(reply({ errors: ['permission denied'] }, 403))
      .mockResolvedValueOnce(login('second-role-token'))
      .mockResolvedValueOnce(read())
    const store = createVaultSecretStore({ ...options, appRole: role, fetch })
    await expect(store.kvCreateOnce('turns/t_task_1_1', credential, custom)).rejects.toMatchObject({
      status: 403,
    })
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(await store.kvRead('turns/t_task_1_1')).toMatchObject({ version: 1 })
    expect(new Headers(fetch.mock.calls[4]?.[1]?.headers).get('x-vault-token')).toBe(
      'second-role-token',
    )
  })
})

// Paths of plan 53 (Р13, Р21, Р24): a variable of a site and the secrets of a preview.
describe('Vault KV paths of site variables and previews', () => {
  const siteId = '0b6f6d1e-5f0f-4c53-9d0a-7c2f4d3e2a10'
  const previewId = '7c2f4d3e-2a10-4c53-9d0a-0b6f6d1e5f0f'

  it.each([
    [`kv/sites/${siteId}/env/PAYMENT_API_KEY`, `kv/data/sites/${siteId}/env/PAYMENT_API_KEY`],
    [`kv/previews/${previewId}/wp`, `kv/data/previews/${previewId}/wp`],
    [`kv/previews/${previewId}/browser`, `kv/data/previews/${previewId}/browser`],
  ])('writes and reads %s under the data path of kv/', async (path, api) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(written(1))
      .mockResolvedValueOnce(read(1))
    const store = withFetch(fetch)
    await store.kvWrite(path, { value: 'synthetic-value' }, { cas: 0 })
    await store.kvRead(path)
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      `${address}/v1/${api}`,
      `${address}/v1/${api}`,
    ])
  })

  it('limits the versions of a variable on its metadata before writing the value', async () => {
    const path = `kv/sites/${siteId}/env/PAYMENT_API_KEY`
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(written(2))
    await expect(
      withFetch(fetch).kvWrite(path, { removed: createdTime }, { cas: 1, maxVersions: 1 }),
    ).resolves.toEqual({ version: 2 })
    expect(
      fetch.mock.calls.map(([url, init]) => [url, init?.method, JSON.parse(String(init?.body))]),
    ).toEqual([
      // A string: the only form a policy can allow a value of (sites-writer allows "1").
      [
        `${address}/v1/kv/metadata/sites/${siteId}/env/PAYMENT_API_KEY`,
        'POST',
        { max_versions: '1' },
      ],
      [
        `${address}/v1/kv/data/sites/${siteId}/env/PAYMENT_API_KEY`,
        'POST',
        { options: { cas: 1 }, data: { removed: createdTime } },
      ],
    ])
  })

  it('writes no value when the limit of versions is refused', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(reply({ errors: ['permission denied'] }, 403))
    await expect(
      withFetch(fetch).kvWrite(
        `kv/sites/${siteId}/env/PAYMENT_API_KEY`,
        { value: 'synthetic-value' },
        { cas: 0, maxVersions: 1 },
      ),
    ).rejects.toMatchObject({ name: 'VaultError', status: 403 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([0, 101, 1.5, -1, Number.NaN])(
    'refuses the limit of versions %s before any request',
    async (maxVersions) => {
      const fetch = vi.fn<typeof globalThis.fetch>()
      await expect(
        withFetch(fetch).kvWrite(
          `kv/sites/${siteId}/env/PAYMENT_API_KEY`,
          { value: 'synthetic-value' },
          { cas: 0, maxVersions },
        ),
      ).rejects.toBeInstanceOf(VaultError)
      expect(fetch).not.toHaveBeenCalled()
    },
  )

  it('removes every version of the secrets of a preview through its metadata', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(empty())
    await withFetch(fetch).kvDestroyAll(`kv/previews/${previewId}/wp`)
    const [url, init] = fetch.mock.calls[0]!
    expect(url).toBe(`${address}/v1/kv/metadata/previews/${previewId}/wp`)
    expect(init?.method).toBe('DELETE')
  })
})
