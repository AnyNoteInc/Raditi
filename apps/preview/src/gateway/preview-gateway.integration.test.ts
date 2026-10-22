import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { INestApplicationContext } from '@nestjs/common'
import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { startPreview } from '../start.ts'
import { testPreviewConfig } from '../testing/fakes.ts'
import { writePreviewRows, type PreviewRows } from '../testing/preview-rows.ts'
import { PreviewGatewayServer } from './preview-gateway.server.ts'

// The app as main.ts starts it — its modules, its own client of the database — against rows of
// its own, removed at the end; run by verify:db's disposable database (or any throwaway one)
// with RADITI_GATEWAY_DB_TESTS=1.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('the preview app on PostgreSQL', () => {
  let db: PrismaClient
  let rows: PreviewRows
  let app: INestApplicationContext | undefined

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl! })
    rows = await writePreviewRows(db)
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    if (!db) return
    await rows?.remove()
    await db.$disconnect()
  })

  it('carries a visitor from the ticket to the site through the gateway', async () => {
    const seen: IncomingHttpHeaders[] = []
    const site = createServer((request, response) => {
      seen.push(request.headers)
      response.end('страница')
    })
    site.listen(0, '127.0.0.1')
    await once(site, 'listening')
    const target = await rows.preview()
    await db.previewEnvironment.update({
      where: { id: target.id },
      data: { upstreamPort: (site.address() as AddressInfo).port },
    })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    app = await startPreview({ ...testPreviewConfig(), db: { databaseUrl: databaseUrl! }, port: 0 })
    const port = app.get(PreviewGatewayServer).address()!.port
    const get = (path: string, cookie?: string) =>
      new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const request = httpRequest(
            {
              host: '127.0.0.1',
              port,
              path,
              headers: { host: `${target.hostname}:8090`, ...(cookie ? { cookie } : {}) },
              agent: false,
            },
            (response) => {
              let body = ''
              response.on('data', (chunk: Buffer) => (body += chunk.toString()))
              response.on('end', () =>
                resolve({ status: response.statusCode ?? 0, headers: response.headers, body }),
              )
            },
          )
          request.on('error', reject)
          request.end()
        },
      )
    try {
      const token = await rows.ticket(target.id)
      const entered = await get(`/__raditi/enter?t=${token}&to=%2Fabout%2F`)
      expect(entered.status).toBe(303)
      expect(entered.headers.location).toBe(`http://${target.hostname}:8090/about/`)
      const cookie = String(entered.headers['set-cookie']?.[0]).split(';')[0]!
      const page = await get('/about/', `wp=1; ${cookie}`)
      expect(page.status).toBe(200)
      expect(page.body).toBe('страница')
      expect(seen[0]?.cookie).toBe('wp=1')
      // The first document of the row's revision in this browser clears the origin, once.
      const { revision } = await db.previewEnvironment.findUniqueOrThrow({
        where: { id: target.id },
      })
      expect(page.headers['clear-site-data']).toBe('"cache", "storage"')
      const recorded = String(page.headers['set-cookie']?.[0]).split(';')[0]!
      expect(recorded).toBe(`__Host-raditi-preview-rev=${revision}`)
      const again = await get('/about/', `${cookie}; ${recorded}`)
      expect(again.headers['clear-site-data']).toBeUndefined()
      expect((await get(`/__raditi/enter?t=${token}`)).status).toBe(403)
    } finally {
      await app.close()
      app = undefined
      site.close()
    }
  })
})
