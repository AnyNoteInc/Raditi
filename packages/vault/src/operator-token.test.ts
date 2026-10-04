import { describe, expect, it, vi } from 'vitest'

import { createDevSubscriptionToken } from './operator-token.ts'

const options = {
  appEnv: 'test',
  addr: 'http://127.0.0.1:8200',
  rootToken: 'synthetic-root',
  policy: 'writer',
} as const
const issued = (changes = {}) =>
  new Response(
    JSON.stringify({
      auth: {
        client_token: 'synthetic-writer',
        policies: ['subscriptions-writer'],
        lease_duration: 900,
        renewable: false,
        ...changes,
      },
    }),
  )

describe('explicit dev subscription operator tokens', () => {
  it('requests only the named policy, no default, nonrenewable and bounded to 15 minutes', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(issued())
    expect(await createDevSubscriptionToken({ ...options, fetch })).toBe('synthetic-writer')
    expect(fetch).toHaveBeenCalledOnce()
    const [url, request] = fetch.mock.calls[0]!
    expect(url).toBe('http://127.0.0.1:8200/v1/auth/token/create')
    expect(request?.redirect).toBe('error')
    expect(JSON.parse(request?.body as string)).toEqual({
      policies: ['subscriptions-writer'],
      no_default_policy: true,
      ttl: '15m',
      explicit_max_ttl: '15m',
      renewable: false,
    })
  })
  it('permits the separate admin policy', async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(issued({ policies: ['subscriptions-admin'] }))
    await createDevSubscriptionToken({ ...options, policy: 'admin', fetch })
    expect(JSON.parse(fetch.mock.calls[0]![1]?.body as string).policies).toEqual([
      'subscriptions-admin',
    ])
  })
  it.each([
    { appEnv: 'production' },
    { addr: 'http://vault.internal:8200' },
    { addr: 'http://192.168.1.1:8200' },
    { addr: 'http://user:private@127.0.0.1:8200' },
    { addr: 'http://127.0.0.1:8200/prefix' },
    { policy: 'root' },
    { policy: '__proto__' },
    { rootToken: 'private\nvalue' },
  ])('rejects unsafe configuration before sending a root token: %j', async (change) => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    await expect(
      createDevSubscriptionToken({ ...options, ...change, fetch } as Parameters<
        typeof createDevSubscriptionToken
      >[0]),
    ).rejects.toThrow('Dev subscription token issuance failed')
    expect(fetch).not.toHaveBeenCalled()
  })
  it.each([
    { policies: ['root'] },
    { policies: ['subscriptions-writer', 'default'] },
    { lease_duration: 901 },
    { renewable: true },
  ])('rejects unexpected privilege or lifetime: %j', async (change) => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(issued(change))
    await expect(createDevSubscriptionToken({ ...options, fetch })).rejects.toThrow(
      'Dev subscription token issuance failed',
    )
  })
  it('does not disclose malformed secret-bearing responses or transport errors', async () => {
    for (const fetch of [
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response('private-root-response')),
      vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValue(new Error('synthetic-root private-header')),
    ]) {
      await expect(createDevSubscriptionToken({ ...options, fetch })).rejects.toThrow(
        /^Dev subscription token issuance failed$/,
      )
    }
  })
})
