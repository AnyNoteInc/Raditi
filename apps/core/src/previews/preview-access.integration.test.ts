import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createPrismaClient, type PrismaClient } from '@repo/db'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  PostgresPreviewAccess,
  PREVIEW_SESSION_HOURS,
  previewCookieValue,
  PreviewGatewayServer,
  previewTicketHash,
} from '@repo/preview-gateway'

// Users, workspaces, sites and tasks of its own, removed at the end; run by verify:db's disposable
// database (or any throwaway one) with RADITI_GATEWAY_DB_TESTS=1.
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')

describe.skipIf(!enabled)('PostgresPreviewAccess', () => {
  let db: PrismaClient
  let access: PostgresPreviewAccess
  const created = { users: [] as string[], workspaces: [] as string[], sites: [] as string[] }
  let owner: string
  let stranger: string
  let workspaceId: string
  let siteId: string
  let preview: { id: string; hostname: string }
  let other: { id: string; hostname: string }

  async function user(): Promise<string> {
    const row = await db.user.create({
      data: { name: 'Предпросмотр', email: `preview-${randomUUID()}@example.test` },
    })
    created.users.push(row.id)
    return row.id
  }

  async function previewOf(site: string): Promise<{ id: string; hostname: string }> {
    const task = await db.task.create({ data: { workspaceId, siteId: site } })
    const { alias } = await db.site.findUniqueOrThrow({ where: { id: site } })
    const row = await db.previewEnvironment.create({
      data: {
        siteId: site,
        taskId: task.id,
        status: 'ready',
        hostname: `site-${alias}-chat-${task.alias}.localhost`,
        upstreamHost: '127.0.0.1',
        upstreamPort: 1,
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    })
    return { id: row.id, hostname: row.hostname }
  }

  async function ticket(
    previewId: string,
    options: { kind?: 'user' | 'browser'; userId?: string | null; expiresIn?: number } = {},
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const kind = options.kind ?? 'user'
    await db.previewTicket.create({
      data: {
        previewId,
        kind,
        userId: kind === 'user' ? (options.userId ?? owner) : null,
        tokenHash: previewTicketHash(token),
        expiresAt: new Date(Date.now() + (options.expiresIn ?? 60_000)),
      },
    })
    return token
  }

  const enter = (previewId: string, token: string, kind: 'user' | 'browser' = 'user') =>
    access.enter({ previewId, tokenHash: previewTicketHash(token), kind })

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl! })
    access = new PostgresPreviewAccess(db)
    owner = await user()
    stranger = await user()
    const workspace = await db.workspace.create({
      data: { name: 'Предпросмотры', dataClass: 'synthetic', createdById: owner },
    })
    workspaceId = workspace.id
    created.workspaces.push(workspace.id)
    await db.member.create({ data: { workspaceId, userId: owner, role: 'owner' } })
    const site = await db.site.create({
      data: {
        workspaceId,
        name: 'Сайт',
        url: `https://${randomUUID()}.example.test`,
        stack: 'wordpress',
        status: 'active',
      },
    })
    siteId = site.id
    created.sites.push(site.id)
    preview = await previewOf(siteId)
    other = await previewOf(siteId)
  })

  beforeEach(async () => {
    await db.site.update({ where: { id: siteId }, data: { status: 'active' } })
    await db.member.upsert({
      where: { workspaceId_userId: { workspaceId, userId: owner } },
      create: { workspaceId, userId: owner, role: 'owner' },
      update: {},
    })
  })

  afterAll(async () => {
    if (!db) return
    await db.previewEnvironment.deleteMany({ where: { siteId: { in: created.sites } } })
    await db.task.deleteMany({ where: { siteId: { in: created.sites } } })
    await db.site.deleteMany({ where: { id: { in: created.sites } } })
    await db.workspace.deleteMany({ where: { id: { in: created.workspaces } } })
    await db.user.deleteMany({ where: { id: { in: created.users } } })
    await db.$disconnect()
  })

  it('finds a preview by its exact hostname only, never a destroyed one', async () => {
    const route = await access.route(preview.hostname)
    expect(route).toMatchObject({
      id: preview.id,
      siteId,
      hostname: preview.hostname,
      status: 'ready',
      revision: 0,
      accessEpoch: 0,
      upstream: { host: '127.0.0.1', port: 1 },
    })
    expect(await access.route(preview.hostname.toUpperCase())).toBeNull()
    expect(await access.route(`x${preview.hostname}`)).toBeNull()
    const gone = await previewOf(siteId)
    await db.previewEnvironment.update({ where: { id: gone.id }, data: { status: 'destroyed' } })
    expect(await access.route(gone.hostname)).toBeNull()
  })

  it('spends a ticket once, even when it arrives several times at once', async () => {
    const token = await ticket(preview.id)
    const sessions = await Promise.all([1, 2, 3, 4, 5].map(() => enter(preview.id, token)))
    const opened = sessions.filter((session) => session !== null)
    expect(opened).toHaveLength(1)
    expect(opened[0]).toMatchObject({
      previewId: preview.id,
      userId: owner,
      kind: 'user',
      accessEpoch: 0,
      revokedAt: null,
    })
    const hours = (opened[0]!.expiresAt.getTime() - opened[0]!.checkedAt!.getTime()) / 3_600_000
    expect(hours).toBe(PREVIEW_SESSION_HOURS)
    expect(await enter(preview.id, token)).toBeNull()
    const row = await db.previewTicket.findUniqueOrThrow({
      where: { tokenHash: previewTicketHash(token) },
    })
    expect(row.usedAt).not.toBeNull()
  })

  it('takes a ticket only for its own preview and kind, within its minute', async () => {
    const token = await ticket(preview.id)
    // Of another preview or as the browser's: not spent, still good where it belongs.
    expect(await enter(other.id, token)).toBeNull()
    expect(await enter(preview.id, token, 'browser')).toBeNull()
    expect(await enter(preview.id, token)).not.toBeNull()
    const late = await ticket(preview.id, { expiresIn: -1 })
    expect(await enter(preview.id, late)).toBeNull()
    const browser = await ticket(preview.id, { kind: 'browser' })
    expect(await enter(preview.id, browser, 'browser')).toMatchObject({
      kind: 'browser',
      userId: null,
    })
  })

  it('opens nothing for a stranger or a closed site, and the ticket stays spent', async () => {
    const foreign = await ticket(preview.id, { userId: stranger })
    expect(await enter(preview.id, foreign)).toBeNull()
    expect(
      (
        await db.previewTicket.findUniqueOrThrow({
          where: { tokenHash: previewTicketHash(foreign) },
        })
      ).usedAt,
    ).not.toBeNull()
    for (const status of ['paused', 'disconnected', 'archived'] as const) {
      await db.site.update({ where: { id: siteId }, data: { status } })
      expect(await enter(preview.id, await ticket(preview.id)), status).toBeNull()
    }
  })

  it('reads a session back with the expiry its cookie was signed with', async () => {
    const session = (await enter(preview.id, await ticket(preview.id)))!
    const read = (await access.session(session.id))!
    expect(read).toEqual(session)
    const secret = 'x'.repeat(48)
    expect(previewCookieValue(secret, read, preview.hostname)).toBe(
      previewCookieValue(secret, session, preview.hostname),
    )
    expect(await access.session(randomUUID())).toBeNull()
  })

  it('checks membership, the site and the access epoch again, and revokes for good', async () => {
    const session = (await enter(preview.id, await ticket(preview.id)))!
    const checked = await access.recheck(session.id)
    expect(checked?.checkedAt.getTime()).toBeGreaterThanOrEqual(session.checkedAt!.getTime())

    await db.member.delete({ where: { workspaceId_userId: { workspaceId, userId: owner } } })
    expect(await access.recheck(session.id)).toBeNull()
    expect((await access.session(session.id))?.revokedAt).not.toBeNull()
    await db.member.create({ data: { workspaceId, userId: owner, role: 'owner' } })
    expect(await access.recheck(session.id)).toBeNull()

    const archived = (await enter(preview.id, await ticket(preview.id)))!
    await db.site.update({ where: { id: siteId }, data: { status: 'archived' } })
    expect(await access.recheck(archived.id)).toBeNull()
    await db.site.update({ where: { id: siteId }, data: { status: 'active' } })

    const browser = (await enter(other.id, await ticket(other.id, { kind: 'browser' }), 'browser'))!
    expect(await access.recheck(browser.id)).not.toBeNull()
    await db.previewEnvironment.update({
      where: { id: other.id },
      data: { accessEpoch: { increment: 1 } },
    })
    expect(await access.recheck(browser.id)).toBeNull()
  })

  it('carries a visitor from the ticket to the site through the gateway', async () => {
    const seen: IncomingHttpHeaders[] = []
    const site = createServer((request, response) => {
      seen.push(request.headers)
      response.end('страница')
    })
    site.listen(0, '127.0.0.1')
    await once(site, 'listening')
    const target = await previewOf(siteId)
    await db.previewEnvironment.update({
      where: { id: target.id },
      data: { upstreamPort: (site.address() as AddressInfo).port },
    })
    const gateway = new PreviewGatewayServer({
      appEnv: 'test',
      address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
      sessionSecret: 'y'.repeat(48),
      appUrl: 'http://localhost:3000',
      browserRelays: [],
      store: access,
    })
    const { port } = await gateway.listen(0, '127.0.0.1')
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
      const token = await ticket(target.id)
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
      await gateway.close()
      site.close()
    }
  })
})
