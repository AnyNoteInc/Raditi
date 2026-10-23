import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'

import type { KvSecret, PublishedContentGateway, SiteContentAdapter } from '@repo/domain'
import { getSiteContentAdapter } from '@repo/site-adapters'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  createPreviewContentResolver,
  type McpPreviewTarget,
  type PreviewGatewayFactory,
} from './preview-content.ts'

const previewId = '0196abcd-0000-7000-8000-0000000000aa'
const HOST = 'site-0a1b2c3d-chat-0a1b2c.localhost'
const ORIGIN = `http://${HOST}:8090`
const address = { baseDomain: 'localhost', scheme: 'http' as const, publicPort: 8090 }
const target: McpPreviewTarget = {
  previewId,
  siteId: '0196abcd-0000-7000-8000-000000000004',
  workspaceId: '0196abcd-0000-7000-8000-000000000003',
  stack: 'wordpress',
  hostname: HOST,
  upstream: { host: '127.0.0.1', port: 41_234 },
  writeEpoch: 2,
}
const PASSWORD = 'preview-application-password-0123'
const access = { origin: ORIGIN, token: PASSWORD }

/** A stack-neutral adapter: the resolver names no CMS and needs nothing else. */
const adapter: SiteContentAdapter<{ origin: string; token: string }> = {
  stack: 'wordpress',
  accessKind: 'wp',
  accessSchema: z.strictObject({ origin: z.url(), token: z.string().min(8) }),
  createGateway: () => ({}) as PublishedContentGateway,
}

function setup({
  secret = { data: access, version: 1 } as KvSecret | null,
  address: where = address as typeof address | null,
} = {}) {
  const state = { secret, now: 1_800_000_000_000 }
  const kvRead = vi.fn(async (_path: string) => state.secret)
  const built: Parameters<PreviewGatewayFactory>[0][] = []
  const gateway = vi.fn<PreviewGatewayFactory>((input) => {
    built.push(input)
    return { built: built.length } as unknown as PublishedContentGateway
  })
  const refusals: string[] = []
  const resolve = createPreviewContentResolver({
    secrets: { kvRead },
    adapters: () => adapter as SiteContentAdapter,
    address: where,
    upstreamHost: '127.0.0.1',
    gateway,
    now: () => state.now,
    onRefusal: (reason) => refusals.push(reason),
  })
  return { resolve, state, kvRead, built, gateway, refusals }
}

const refusedFor = (reason: string) =>
  expect.objectContaining({ code: 'CONTENT_PREVIEW_UNAVAILABLE', details: { reason } })

let server: Server | undefined
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
  server = undefined
})

describe('the gateway to the content of a preview', () => {
  it('reads the access the build created for this preview and binds the gateway to it', async () => {
    const { resolve, kvRead, built } = setup()
    await resolve(target)
    expect(kvRead).toHaveBeenCalledExactlyOnceWith(`kv/previews/${previewId}/wp`)
    expect(built).toEqual([
      {
        adapter,
        // The plugin of the copy is bound to the preview, never to the site (R5b).
        previewId,
        origin: ORIGIN,
        access,
        target: { upstream: { host: '127.0.0.1', port: 41_234 }, hostname: HOST },
      },
    ])
  })

  it('refuses an upstream on another host, an access of another preview and no previews at all', async () => {
    const other = setup()
    await expect(
      other.resolve({ ...target, upstream: { host: '10.0.0.5', port: 80 } }),
    ).rejects.toEqual(refusedFor('upstream'))
    await expect(
      other.resolve({ ...target, upstream: { host: '127.0.0.1', port: 0 } }),
    ).rejects.toEqual(refusedFor('upstream'))
    expect(other.kvRead).not.toHaveBeenCalled()

    const foreign = setup({
      secret: {
        data: { ...access, origin: 'http://site-0a1b2c3d-chat-ffffff.localhost:8090' },
        version: 1,
      },
    })
    await expect(foreign.resolve(target)).rejects.toEqual(refusedFor('origin'))
    // The site's own address is not the preview's either.
    foreign.state.secret = { data: { ...access, origin: 'https://site.example.test' }, version: 1 }
    await expect(foreign.resolve(target)).rejects.toEqual(refusedFor('origin'))
    expect(foreign.gateway).not.toHaveBeenCalled()

    const none = setup({ address: null })
    await expect(none.resolve(target)).rejects.toEqual(refusedFor('address'))
    expect(none.refusals).toEqual(['address'])

    const missing = setup({ secret: null })
    await expect(missing.resolve(target)).rejects.toEqual(refusedFor('secret'))
    const malformed = setup({ secret: { data: { origin: ORIGIN }, version: 1 } })
    await expect(malformed.resolve(target)).rejects.toEqual(refusedFor('format'))
    const outage = setup()
    outage.kvRead.mockRejectedValueOnce(new Error(`vault said ${PASSWORD}`))
    const error = await outage.resolve(target).catch((caught: unknown) => caught)
    expect(error).toEqual(refusedFor('vault'))
    expect(JSON.stringify(error)).not.toContain(PASSWORD)
  })

  it('keeps a gateway for a while, never across another upstream or write epoch', async () => {
    const { resolve, state, kvRead } = setup()
    const first = await resolve(target)
    expect(await resolve(target)).toBe(first)
    expect(kvRead).toHaveBeenCalledOnce()
    // A rebuild issues a new password and may move the upstream.
    expect(await resolve({ ...target, writeEpoch: 3 })).not.toBe(first)
    await resolve({ ...target, writeEpoch: 3, upstream: { host: '127.0.0.1', port: 41_235 } })
    expect(kvRead).toHaveBeenCalledTimes(3)
    state.now += 60_001
    await resolve({ ...target, writeEpoch: 3, upstream: { host: '127.0.0.1', port: 41_235 } })
    expect(kvRead).toHaveBeenCalledTimes(4)
  })

  it('reaches the upstream of the preview over http with its Host, wherever the gateway points', async () => {
    const seen: Array<{ method?: string; url?: string; headers: IncomingHttpHeaders }> = []
    server = createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, headers: req.headers })
      res.writeHead(421).end()
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const wordpress = getSiteContentAdapter('wordpress')
    const resolve = createPreviewContentResolver({
      secrets: {
        kvRead: async () => ({
          version: 1,
          data: {
            v: '1',
            origin: ORIGIN,
            username: 'raditi',
            applicationPassword: 'abcd efgh ijkl mnop qrst uvwx',
          },
        }),
      },
      adapters: () => wordpress,
      address,
      upstreamHost: '127.0.0.1',
    })
    const gateway = await resolve({ ...target, upstream: { host: '127.0.0.1', port } })
    await expect(gateway.read('page:42')).rejects.toBeDefined()
    expect(seen).toHaveLength(1)
    expect(seen[0]!.headers.host).toBe(HOST)
    expect(seen[0]!.url?.startsWith('/')).toBe(true)
    // The application password goes to the preview's upstream, which is on this machine.
    expect(seen[0]!.headers.authorization).toMatch(/^Basic /)
  })
})
