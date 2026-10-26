import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createPinnedSiteTransport } from '@repo/site-connections/hosting'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  FaviconCache,
  faviconLimits,
  faviconType,
  getSiteFavicon,
  type SiteFaviconDependencies,
} from './site-favicon'

// The icon of a site for the tile of its rail: fetched by the server from the site's own origin,
// served only to a member of its workspace, only when its bytes are a raster image.

const siteId = '0199a3f2-0000-7000-8000-0000000000c1'
const ico = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16, 0, 0])
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
const request = () => new Request(`http://localhost/api/projects/${siteId}/favicon`)

// A site on loopback: what it answers on each path is set by the test.
type Route = (response: ServerResponse) => void
const routes = new Map<string, Route>()
let server: Server
let origin = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    const route = routes.get(req.url ?? '')
    if (route) route(res)
    else res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://localhost:${(server.address() as AddressInfo).port}`
})
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

// `localhost` is pinned to 127.0.0.1 without a lookup; outside production loopback is allowed.
const loopbackTransport = createPinnedSiteTransport({
  lookup: async () => [{ address: '127.0.0.1', family: 4 }],
  appEnv: 'development',
})

function deps(patch: Partial<SiteFaviconDependencies> = {}) {
  return {
    getSession: vi.fn(async () => ({ user: { id: '0199a3f2-0000-7000-8000-0000000000a1' } })),
    hasRequiredConsents: vi.fn(async () => true),
    siteOrigin: vi.fn(async () => origin),
    transport: loopbackTransport,
    cache: new FaviconCache(),
    onFailure: vi.fn(),
    ...patch,
  } satisfies SiteFaviconDependencies
}

const bytesOf = async (response: Response) => new Uint8Array(await response.arrayBuffer())

describe('the icon of a site', () => {
  it('serves /favicon.ico of the site by the type its bytes are, private and never sniffed', async () => {
    routes.set('/favicon.ico', (res) =>
      // What the site says it is does not count: the bytes are an ICO.
      res.writeHead(200, { 'content-type': 'text/html' }).end(Buffer.from(ico)),
    )
    const d = deps()
    const response = await getSiteFavicon(request(), { projectId: siteId }, d)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/x-icon')
    expect(response.headers.get('cache-control')).toBe('private, max-age=86400')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(await bytesOf(response)).toEqual(ico)
    expect(d.siteOrigin).toHaveBeenCalledWith({ headers: expect.any(Headers), siteId })
  })

  it('asks the site once and answers from the cache until the entry expires', async () => {
    let asked = 0
    routes.set('/favicon.ico', (res) => {
      asked += 1
      res.writeHead(200).end(Buffer.from(png))
    })
    let now = 1_000
    const d = deps({ now: () => now })
    expect((await getSiteFavicon(request(), { projectId: siteId }, d)).status).toBe(200)
    expect((await getSiteFavicon(request(), { projectId: siteId }, d)).status).toBe(200)
    expect(asked).toBe(1)
    now += faviconLimits.foundMs + 1
    expect((await getSiteFavicon(request(), { projectId: siteId }, d)).status).toBe(200)
    expect(asked).toBe(2)
  })

  it('has no icon for an answer that is not a raster image — SVG included', async () => {
    routes.set('/favicon.ico', (res) =>
      res.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg onload="alert(1)"/>'),
    )
    const response = await getSiteFavicon(request(), { projectId: siteId }, deps())
    expect(response.status).toBe(404)
    expect(response.headers.get('cache-control')).toBe('no-store')
  })

  it('has no icon for an answer larger than its limit', async () => {
    routes.set('/favicon.ico', (res) =>
      res
        .writeHead(200)
        .end(Buffer.concat([Buffer.from(ico), Buffer.alloc(faviconLimits.maxBytes)])),
    )
    const d = deps()
    expect((await getSiteFavicon(request(), { projectId: siteId }, d)).status).toBe(404)
    expect(d.onFailure).toHaveBeenCalledWith('site favicon fetch failed', expect.any(Error))
  })

  it('gives up a site that does not answer within its time', async () => {
    routes.set('/favicon.ico', () => {
      // Never answered: the transport's deadline ends the request.
    })
    const started = Date.now()
    const response = await getSiteFavicon(request(), { projectId: siteId }, deps())
    expect(response.status).toBe(404)
    expect(Date.now() - started).toBeLessThan(faviconLimits.timeoutMs + 2_000)
  }, 10_000)

  it('follows a redirect within the site, never to another origin', async () => {
    routes.set('/favicon.ico', (res) => res.writeHead(301, { location: '/icons/site.png' }).end())
    routes.set('/icons/site.png', (res) => res.writeHead(200).end(Buffer.from(png)))
    const within = await getSiteFavicon(request(), { projectId: siteId }, deps())
    expect(within.status).toBe(200)
    expect(within.headers.get('content-type')).toBe('image/png')

    const transport = vi.fn(loopbackTransport)
    routes.set('/favicon.ico', (res) =>
      res.writeHead(302, { location: 'http://127.0.0.1:9/favicon.ico' }).end(),
    )
    const elsewhere = await getSiteFavicon(request(), { projectId: siteId }, deps({ transport }))
    expect(elsewhere.status).toBe(404)
    // The other origin is never asked.
    expect(transport).toHaveBeenCalledTimes(1)
  })

  it('answers the same for a site of someone else, an id that is not one, and no session', async () => {
    const transport = vi.fn(loopbackTransport)
    const other = await getSiteFavicon(
      request(),
      { projectId: siteId },
      deps({ siteOrigin: vi.fn(async () => null), transport }),
    )
    expect(other.status).toBe(404)
    expect(
      (await getSiteFavicon(request(), { projectId: 'favicon.ico' }, deps({ transport }))).status,
    ).toBe(404)
    expect(transport).not.toHaveBeenCalled()
    const anonymous = await getSiteFavicon(
      request(),
      { projectId: siteId },
      deps({ getSession: vi.fn(async () => null) }),
    )
    expect(anonymous.status).toBe(401)
    const unconsented = await getSiteFavicon(
      request(),
      { projectId: siteId },
      deps({ hasRequiredConsents: vi.fn(async () => false) }),
    )
    expect(unconsented.status).toBe(428)
  })

  it('answers 503 when the access check itself fails, and says nothing of why', async () => {
    const d = deps({ siteOrigin: vi.fn(async () => Promise.reject(new Error('db down'))) })
    const response = await getSiteFavicon(request(), { projectId: siteId }, d)
    expect(response.status).toBe(503)
    expect(await response.text()).toBe('')
    expect(d.onFailure).toHaveBeenCalledWith('site favicon failed', expect.any(Error))
  })
})

describe('faviconType', () => {
  it('names the raster formats by their leading bytes only', () => {
    expect(faviconType(ico)).toBe('image/x-icon')
    expect(faviconType(png)).toBe('image/png')
    expect(faviconType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe('image/gif')
    expect(faviconType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(faviconType(new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe(
      'image/webp',
    )
    expect(faviconType(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      null,
    )
    expect(faviconType(new Uint8Array([0, 0]))).toBe(null)
  })
})

describe('FaviconCache', () => {
  it('drops the oldest site past its limit', () => {
    const cache = new FaviconCache(2)
    cache.set('a', { image: null, expiresAt: 10 })
    cache.set('b', { image: null, expiresAt: 10 })
    cache.set('c', { image: null, expiresAt: 10 })
    expect(cache.get('a', 0)).toBeUndefined()
    expect(cache.get('b', 0)).toBeDefined()
    expect(cache.get('c', 11)).toBeUndefined()
  })
})
