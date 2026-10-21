import {
  notImplemented,
  siteAccessPath,
  type KvSecret,
  type PublishedContentGateway,
  type SiteContentAdapter,
  type SiteContentConnection,
  type SiteHttpTransport,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createSiteContentResolver, type SiteScope } from './site-content-resolver.ts'

const siteId = '0196abcd-0000-7000-8000-000000000004'
const otherSiteId = '0196abcd-0000-7000-8000-0000000000ff'
const workspaceId = '0196abcd-0000-7000-8000-000000000003'
const scope: SiteScope = {
  workspaceId,
  siteId,
  stack: 'wordpress',
  url: 'https://site.example.test/',
}
const SECRET = 'private-site-password-0123456789'
const refId = '0196abcd-0000-7000-8000-00000000aaaa'
const row = { id: refId, workspaceId, vaultPath: siteAccessPath(siteId, 'wp'), keyVersion: 3 }
const stored = (data: Record<string, string>, version = 3): KvSecret => ({ data, version })
const access = { origin: 'https://site.example.test', token: SECRET }

/** A stack-neutral adapter: the resolver must need nothing else to compose a gateway. */
function fakeAdapter() {
  const connections: SiteContentConnection<{ origin: string; token: string }>[] = []
  const adapter: SiteContentAdapter<{ origin: string; token: string }> = {
    stack: 'wordpress',
    accessKind: 'wp',
    accessSchema: z.strictObject({ origin: z.url(), token: z.string().min(8) }),
    createGateway(connection) {
      connections.push(connection)
      return { connection: connections.length } as unknown as PublishedContentGateway
    },
  }
  return { adapter, connections }
}

function setup({
  rows = [row] as unknown[],
  secret = stored(access) as KvSecret | null,
  allowLoopbackHttp = false,
  ttlMs = 60_000,
} = {}) {
  const { adapter, connections } = fakeAdapter()
  const state = { rows, secret, now: 1_800_000_000_000 }
  const findMany = vi.fn(async (_query: unknown) => state.rows)
  const kvRead = vi.fn(async (_path: string) => state.secret)
  const transport: SiteHttpTransport = vi.fn()
  const adapters = vi.fn((_stack: string) => adapter as SiteContentAdapter)
  const resolve = createSiteContentResolver({
    prisma: { credentialRef: { findMany } } as never,
    secrets: { kvRead },
    adapters,
    transport,
    allowLoopbackHttp,
    ttlMs,
    now: () => state.now,
  })
  return { resolve, state, findMany, kvRead, transport, adapters, connections }
}

const refusal = (reason: string) => ({
  code: 'CONTENT_SITE_ACCESS_UNAVAILABLE',
  message: 'Site content access is unavailable',
  httpStatus: 503,
  details: { reason },
})

describe('createSiteContentResolver', () => {
  it('follows the reference of the site to its Vault secret and builds the gateway by stack', async () => {
    const t = setup()
    const gateway = await t.resolve(scope)
    expect(gateway).toEqual({ connection: 1 })
    expect(t.adapters).toHaveBeenCalledExactlyOnceWith('wordpress')
    // The kind comes from the adapter, the site from the admitted scope.
    expect(t.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { siteId, kind: 'wp' },
      select: { id: true, workspaceId: true, vaultPath: true, keyVersion: true },
      take: 2,
    })
    expect(t.kvRead).toHaveBeenCalledExactlyOnceWith(`kv/sites/${siteId}/wp`)
    expect(t.connections).toEqual([
      {
        siteId,
        origin: 'https://site.example.test',
        access,
        transport: t.transport,
        allowLoopbackHttp: false,
      },
    ])
  })

  it('refuses a site without a reference and never asks Vault', async () => {
    const t = setup({ rows: [] })
    await expect(t.resolve(scope)).rejects.toMatchObject(refusal('reference'))
    expect(t.kvRead).not.toHaveBeenCalled()
    expect(t.connections).toEqual([])
  })

  it('refuses two references of one kind: it does not choose between them', async () => {
    const t = setup({ rows: [row, { ...row, id: '0196abcd-0000-7000-8000-00000000bbbb' }] })
    await expect(t.resolve(scope)).rejects.toMatchObject(refusal('reference'))
    expect(t.kvRead).not.toHaveBeenCalled()
  })

  it.each([
    ['another site', `kv/sites/${otherSiteId}/wp`],
    ['another kind of the same site', `kv/sites/${siteId}/ssh`],
    ['below the site prefix', `kv/sites/${siteId}/wp/extra`],
    ['a traversal out of the prefix', `kv/sites/${siteId}/../${otherSiteId}/wp`],
    ['another mount', `subs/zai-coding/${siteId}`],
    ['the contact maps', `kv/content-masks/${siteId}/wp`],
    ['a prefix without the mount', `sites/${siteId}/wp`],
  ])(
    'refuses a reference whose path is not the path of this site: %s',
    async (_name, vaultPath) => {
      const t = setup({ rows: [{ ...row, vaultPath }] })
      await expect(t.resolve(scope)).rejects.toMatchObject(refusal('path'))
      expect(t.kvRead).not.toHaveBeenCalled()
    },
  )

  it('refuses a reference of another workspace', async () => {
    const t = setup({ rows: [{ ...row, workspaceId: '0196abcd-0000-7000-8000-00000000cccc' }] })
    await expect(t.resolve(scope)).rejects.toMatchObject(refusal('reference'))
    expect(t.kvRead).not.toHaveBeenCalled()
  })

  it('refuses a broken reference row instead of guessing', async () => {
    for (const broken of [
      { ...row, keyVersion: 0 },
      { ...row, keyVersion: 1.5 },
      { ...row, vaultPath: 7 },
      { ...row, id: 'not-a-uuid' },
    ]) {
      const t = setup({ rows: [broken] })
      await expect(t.resolve(scope)).rejects.toMatchObject(refusal('reference'))
      expect(t.kvRead).not.toHaveBeenCalled()
    }
  })

  it('refuses a missing secret and a version the database does not name', async () => {
    const missing = setup({ secret: null })
    await expect(missing.resolve(scope)).rejects.toMatchObject(refusal('secret'))
    // A rotation in flight: Vault already has version 4, the row still names 3 (or the reverse).
    for (const version of [2, 4]) {
      const t = setup({ secret: stored(access, version) })
      await expect(t.resolve(scope)).rejects.toMatchObject(refusal('version'))
      expect(t.connections).toEqual([])
    }
  })

  it.each([
    ['a field is missing', { origin: access.origin }],
    ['a field is empty', { origin: access.origin, token: '' }],
    ['an unknown field', { ...access, siteId: otherSiteId }],
    ['no origin', { token: SECRET }],
    ['nothing', {}],
  ])('refuses an incomplete secret without repeating it: %s', async (_name, data) => {
    const t = setup({ secret: stored(data as Record<string, string>) })
    const error: unknown = await t.resolve(scope).catch((reason: unknown) => reason)
    expect(error).toMatchObject(refusal('format'))
    expect(JSON.stringify(error) + String((error as Error).stack)).not.toContain(SECRET)
    expect(t.connections).toEqual([])
  })

  it.each([
    'https://other.example.test',
    'http://site.example.test',
    'https://site.example.test:8443',
    'https://site.example.test.attacker.example',
  ])('refuses a secret issued for another origin: %s', async (origin) => {
    const t = setup({ secret: stored({ ...access, origin }) })
    await expect(t.resolve(scope)).rejects.toMatchObject(refusal('origin'))
    expect(t.connections).toEqual([])
  })

  it('refuses when the address of the site moved away from the origin of its secret', async () => {
    const t = setup()
    await t.resolve(scope)
    // sites.url changed after the access was cached: the password must not follow it.
    await expect(t.resolve({ ...scope, url: 'https://moved.example.test/' })).rejects.toMatchObject(
      refusal('origin'),
    )
    expect(t.connections).toHaveLength(1)
  })

  it('reports a Vault failure as its own fixed refusal, without the cause', async () => {
    const t = setup()
    t.kvRead.mockRejectedValueOnce(new Error(`permission denied for ${SECRET}`))
    const error: unknown = await t.resolve(scope).catch((reason: unknown) => reason)
    expect(error).toMatchObject(refusal('vault'))
    expect(JSON.stringify(error) + String((error as Error).stack)).not.toContain(SECRET)
    expect((error as Error).cause).toBeUndefined()
  })

  it('refuses a stack without published content', async () => {
    const t = setup()
    t.adapters.mockImplementationOnce(() => {
      throw notImplemented('Published content for bitrix')
    })
    await expect(t.resolve({ ...scope, stack: 'bitrix' })).rejects.toMatchObject(refusal('stack'))
    expect(t.findMany).not.toHaveBeenCalled()
    expect(t.kvRead).not.toHaveBeenCalled()
  })

  it('reads the reference on every call and Vault once per reference and key version', async () => {
    const t = setup()
    const first = await t.resolve(scope)
    expect(await t.resolve(scope)).toBe(first)
    // Another call of the same site: fields besides the site's scope do not matter.
    const nextTurn = { ...scope, turn: 2, taskId: '0196abcd-0000-7000-8000-000000000001' }
    expect(await t.resolve(nextTurn)).toBe(first)
    expect(t.findMany).toHaveBeenCalledTimes(3)
    expect(t.kvRead).toHaveBeenCalledOnce()
    expect(t.connections).toHaveLength(1)
  })

  it('drops the cached access when the reference names a new key version', async () => {
    const t = setup()
    const first = await t.resolve(scope)
    t.state.rows = [{ ...row, keyVersion: 4 }]
    // Vault still answers with version 3: the old password is not used for the new reference.
    await expect(t.resolve(scope)).rejects.toMatchObject(refusal('version'))
    t.state.secret = stored({ ...access, token: 'rotated-site-password-456' }, 4)
    const second = await t.resolve(scope)
    expect(second).not.toBe(first)
    expect(t.kvRead).toHaveBeenCalledTimes(3)
    expect(t.connections.map((connection) => connection.access.token)).toEqual([
      SECRET,
      'rotated-site-password-456',
    ])
    // The new version is cached in turn; the old one is gone for good.
    expect(await t.resolve(scope)).toBe(second)
    t.state.rows = [row]
    await expect(t.resolve(scope)).rejects.toMatchObject(refusal('version'))
  })

  it('drops the cached access when the reference row is replaced or removed', async () => {
    const t = setup()
    await t.resolve(scope)
    t.state.rows = []
    await expect(t.resolve(scope)).rejects.toMatchObject(refusal('reference'))
    t.state.rows = [{ ...row, id: '0196abcd-0000-7000-8000-00000000dddd' }]
    await t.resolve(scope)
    expect(t.kvRead).toHaveBeenCalledTimes(2)
  })

  it('reads Vault again once the cached access is older than its lifetime', async () => {
    const t = setup({ ttlMs: 1000 })
    const first = await t.resolve(scope)
    t.state.now += 999
    expect(await t.resolve(scope)).toBe(first)
    t.state.now += 1
    // The secret was removed in Vault: after the lifetime the role stops using its copy.
    t.state.secret = null
    await expect(t.resolve(scope)).rejects.toMatchObject(refusal('secret'))
    expect(t.kvRead).toHaveBeenCalledTimes(2)
  })

  it('serves the copy taken before a rotation until it expires, then waits for the reference', async () => {
    const t = setup({ ttlMs: 1000 })
    const first = await t.resolve(scope)
    // The rotation wrote Vault (version 4); the row still names 3.
    t.state.secret = stored({ ...access, token: 'rotated-site-password-456' }, 4)
    t.state.now += 999
    expect(await t.resolve(scope)).toBe(first)
    expect(t.kvRead).toHaveBeenCalledOnce()
    t.state.now += 1
    // The copy is gone: what Vault holds is not what the row names, so nothing is used.
    await expect(t.resolve(scope)).rejects.toMatchObject(refusal('version'))
    t.state.rows = [{ ...row, keyVersion: 4 }]
    expect(await t.resolve(scope)).not.toBe(first)
    expect(t.connections.map((connection) => connection.access.token)).toEqual([
      SECRET,
      'rotated-site-password-456',
    ])
  })

  it('keeps the cache bounded', async () => {
    const { adapter } = fakeAdapter()
    const kvRead = vi.fn(async (path: string) =>
      stored({ origin: 'https://site.example.test', token: `${SECRET}-${path}` }),
    )
    const site = (index: number) => `0196abcd-0000-7000-8000-${String(index).padStart(12, '0')}`
    const resolve = createSiteContentResolver({
      prisma: {
        credentialRef: {
          findMany: async (query: { where: { siteId: string } }) => [
            {
              id: query.where.siteId,
              workspaceId,
              vaultPath: siteAccessPath(query.where.siteId, 'wp'),
              keyVersion: 3,
            },
          ],
        },
      } as never,
      secrets: { kvRead },
      adapters: () => adapter as SiteContentAdapter,
      transport: vi.fn(),
      allowLoopbackHttp: false,
      maxEntries: 2,
    })
    for (const index of [1, 2, 3]) await resolve({ ...scope, siteId: site(index) })
    await resolve({ ...scope, siteId: site(3) })
    await resolve({ ...scope, siteId: site(2) })
    expect(kvRead).toHaveBeenCalledTimes(3)
    // The first site was evicted and is read again.
    await resolve({ ...scope, siteId: site(1) })
    expect(kvRead).toHaveBeenCalledTimes(4)
  })

  it('tells its owner the reason of every refusal and nothing on success', async () => {
    const reasons: string[] = []
    const { adapter } = fakeAdapter()
    const state = { rows: [] as unknown[] }
    const resolve = createSiteContentResolver({
      prisma: { credentialRef: { findMany: async () => state.rows } } as never,
      secrets: { kvRead: async () => stored(access) },
      adapters: () => adapter as SiteContentAdapter,
      transport: vi.fn(),
      allowLoopbackHttp: false,
      onRefusal: (reason) => reasons.push(reason),
    })
    await resolve(scope).catch(() => {})
    state.rows = [{ ...row, vaultPath: `kv/sites/${otherSiteId}/wp` }]
    await resolve(scope).catch(() => {})
    state.rows = [row]
    await resolve(scope)
    await resolve({ ...scope, url: 'https://moved.example.test/' }).catch(() => {})
    expect(reasons).toEqual(['reference', 'path', 'origin'])
  })

  it('allows plain http to a loopback site only where the composition says so', async () => {
    const local = { ...scope, url: 'http://127.0.0.1:18080/' }
    const secret = stored({ ...access, origin: 'http://127.0.0.1:18080' })
    const allowed = setup({ secret, allowLoopbackHttp: true })
    await allowed.resolve(local)
    expect(allowed.connections[0]).toMatchObject({
      origin: 'http://127.0.0.1:18080',
      allowLoopbackHttp: true,
    })
    const refused = setup({ secret })
    await refused.resolve(local)
    expect(refused.connections[0]).toMatchObject({ allowLoopbackHttp: false })
  })

  it('refuses when the adapter rejects the connection, and caches nothing', async () => {
    const t = setup()
    const { adapter } = fakeAdapter()
    t.adapters.mockReturnValue({
      ...adapter,
      createGateway() {
        throw new Error(`cannot connect with ${SECRET}`)
      },
    } as SiteContentAdapter)
    const error: unknown = await t.resolve(scope).catch((reason: unknown) => reason)
    expect(error).toMatchObject(refusal('adapter'))
    expect(JSON.stringify(error) + String((error as Error).stack)).not.toContain(SECRET)
    await t.resolve(scope).catch(() => {})
    expect(t.kvRead).toHaveBeenCalledTimes(2)
  })
})
