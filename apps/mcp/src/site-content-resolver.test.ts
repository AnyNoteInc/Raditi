import { createHash } from 'node:crypto'

import {
  publishedContentHashMaterial,
  siteAccessPath,
  type KvSecret,
  type SiteHttpRequest,
  type SiteHttpTransport,
} from '@repo/domain'
import { getSiteContentAdapter } from '@repo/site-adapters'
import { describe, expect, it } from 'vitest'
import { createSiteContentResolver } from '@repo/site-content'

import type { McpAccess } from './mcp-access.ts'

// The resolver of @repo/site-content composed as the mcp role composes it, with the adapters of
// the registry (its own cases on a stack-neutral adapter are in the package).

const siteId = '0196abcd-0000-7000-8000-000000000004'
const otherSiteId = '0196abcd-0000-7000-8000-0000000000ff'
const workspaceId = '0196abcd-0000-7000-8000-000000000003'
const scope: McpAccess = {
  keyId: '0196abcd-0000-7000-8000-000000000001',
  taskId: '0196abcd-0000-7000-8000-000000000002',
  workspaceId,
  siteId,
  sessionId: 'synthetic',
  turn: 1,
  firstEpoch: 1,
  epoch: 1,
  stack: 'wordpress',
  url: 'https://site.example.test/',
  preview: null,
}
const SECRET = 'private-site-password-0123456789'
const refId = '0196abcd-0000-7000-8000-00000000aaaa'
const row = { id: refId, workspaceId, vaultPath: siteAccessPath(siteId, 'wp'), keyVersion: 3 }
const stored = (data: Record<string, string>, version = 3): KvSecret => ({ data, version })

const refusal = (reason: string) => ({
  code: 'CONTENT_SITE_ACCESS_UNAVAILABLE',
  message: 'Site content access is unavailable',
  httpStatus: 503,
  details: { reason },
})

describe('the resolver with the adapters of the registry', () => {
  const fields = {
    version: 1 as const,
    objectRef: 'page:42',
    kind: 'page' as const,
    title: 'Заголовок',
    content: '<p>Текст</p>',
    excerpt: '',
  }
  const state = {
    ...fields,
    stateHash: createHash('sha256').update(publishedContentHashMaterial(fields)).digest('hex'),
  }

  /** The companion plugin as a site sees a request: bound to one site id, one password. */
  function plugin(installedSiteId: string) {
    const requests: SiteHttpRequest[] = []
    const expected = `Basic ${Buffer.from(`raditi:${SECRET}`).toString('base64')}`
    const transport: SiteHttpTransport = async (request) => {
      requests.push(request)
      const allowed =
        request.headers.authorization === expected &&
        request.headers['x-raditi-site'] === installedSiteId
      return allowed
        ? { status: 200, body: Buffer.from(JSON.stringify(state)) }
        : { status: 401, body: Buffer.from('{"code":"rest_forbidden"}') }
    }
    return { requests, transport }
  }
  const resolver = (transport: SiteHttpTransport) =>
    createSiteContentResolver({
      prisma: { credentialRef: { findMany: async () => [row] } } as never,
      secrets: {
        kvRead: async () =>
          stored({
            v: '1',
            origin: 'https://site.example.test',
            username: 'raditi',
            applicationPassword: SECRET,
          }),
      },
      adapters: getSiteContentAdapter,
      transport,
      allowLoopbackHttp: false,
    })

  it('reads a page of the site whose installation is bound to this site', async () => {
    const site = plugin(siteId)
    expect(await (await resolver(site.transport)(scope)).read('page:42')).toEqual(state)
    expect(site.requests).toHaveLength(1)
    expect(site.requests[0]!.url).toBe(
      'https://site.example.test/?rest_route=%2Fraditi%2Fv1%2Fcontent%2F42',
    )
  })

  it('matches a site with a Cyrillic name by the punycode origin of its secret', async () => {
    const requests: SiteHttpRequest[] = []
    const resolve = createSiteContentResolver({
      prisma: { credentialRef: { findMany: async () => [row] } } as never,
      secrets: {
        kvRead: async () =>
          stored({
            v: '1',
            origin: 'https://xn--80aswg.xn--p1ai',
            username: 'raditi',
            applicationPassword: SECRET,
          }),
      },
      adapters: getSiteContentAdapter,
      transport: async (request) => {
        requests.push(request)
        return { status: 200, body: Buffer.from(JSON.stringify(state)) }
      },
      allowLoopbackHttp: false,
    })
    // sites.url as the owner typed it; the secret holds what a URL parser makes of it.
    const gateway = await resolve({ ...scope, url: 'https://сайт.рф/' })
    expect(await gateway.read('page:42')).toEqual(state)
    expect(requests[0]!.url).toBe(
      'https://xn--80aswg.xn--p1ai/?rest_route=%2Fraditi%2Fv1%2Fcontent%2F42',
    )
  })

  it('gets nothing from an installation bound to another site', async () => {
    // The right address and the right password, but the plugin there belongs to another site
    // of the platform: the gateway names the admitted site, and the installation refuses it.
    const site = plugin(otherSiteId)
    const gateway = await resolver(site.transport)(scope)
    await expect(gateway.read('page:42')).rejects.toMatchObject({
      code: 'CONTENT_GATEWAY_UNAVAILABLE',
    })
    expect(site.requests.map((request) => request.headers['x-raditi-site'])).toEqual([siteId])
    // Nor can a write be addressed to the installed site through this gateway.
    await expect(
      gateway.conditionalWrite({
        callId: '0196abcd-0000-7000-8000-00000000eeee',
        siteId: otherSiteId,
        epoch: 1,
        requestHash: 'a'.repeat(64),
        objectRef: 'page:42',
        expectedStateHash: state.stateHash,
        deadlineAt: 1_800_000_000_000,
        ttlMs: 1000,
        mode: 'edit',
        fields: { title: 'После' },
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(site.requests).toHaveLength(1)
  })

  it('refuses a stack that has no published content in the registry', async () => {
    const site = plugin(siteId)
    await expect(resolver(site.transport)({ ...scope, stack: 'bitrix' })).rejects.toMatchObject(
      refusal('stack'),
    )
    expect(site.requests).toEqual([])
  })
})
