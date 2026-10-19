import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http'
import { connect, type AddressInfo, type Socket } from 'node:net'

import { PREVIEW_SESSION_COOKIE, type PreviewSessionKind } from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type {
  EnterInput,
  PreviewAccessStore,
  PreviewRoute,
  PreviewSessionRecord,
} from './preview-access.ts'
import { previewCookieValue, previewTicketHash } from './preview-cookie.ts'
import { PreviewGatewayServer, type PreviewGatewayOptions } from './preview-gateway.server.ts'
import { PREVIEW_TICKET_REQUEST } from './preview-pages.ts'

const SECRET = 's'.repeat(48)
const APP = 'http://localhost:3000'
const HOST = 'site-abcd1234-chat-ef5678.localhost'
const OTHER = 'site-abcd1234-chat-000111.localhost'
const ORIGIN = `http://${HOST}:8090`
const T0 = Date.UTC(2026, 9, 17, 12)
const REV = '__Host-raditi-preview-rev'

// ---------------------------------------------------------------------------------------------
// A store in memory, with the semantics of PostgresPreviewAccess
// ---------------------------------------------------------------------------------------------

interface Ticket {
  previewId: string
  userId: string | null
  kind: PreviewSessionKind
  expiresAt: number
  usedAt: number | null
}

class MemoryAccess implements PreviewAccessStore {
  readonly routes = new Map<string, PreviewRoute>()
  readonly tickets = new Map<string, Ticket>()
  readonly sessions = new Map<string, PreviewSessionRecord>()
  /** Users who are members of the site's workspace. */
  readonly members = new Set<string>(['user-1'])
  readonly calls = { route: 0, enter: 0, session: 0, recheck: 0 }
  #next = 1

  constructor(private readonly now: () => number) {}

  addRoute(hostname: string, patch: Partial<PreviewRoute> = {}): PreviewRoute {
    const route: PreviewRoute = {
      id: `preview-${hostname.slice(19, 25)}`,
      siteId: 'site-1',
      hostname,
      status: 'ready',
      revision: 1,
      accessEpoch: 0,
      upstream: null,
      ...patch,
    }
    this.routes.set(hostname, route)
    return route
  }

  ticket(
    route: PreviewRoute,
    kind: PreviewSessionKind = 'user',
    patch: Partial<Ticket> = {},
  ): string {
    const token = randomBytes(32).toString('base64url')
    this.tickets.set(previewTicketHash(token), {
      previewId: route.id,
      userId: kind === 'user' ? 'user-1' : null,
      kind,
      expiresAt: this.now() + 60_000,
      usedAt: null,
      ...patch,
    })
    return token
  }

  async route(hostname: string): Promise<PreviewRoute | null> {
    this.calls.route++
    const route = this.routes.get(hostname)
    return route && route.status !== 'destroyed' ? { ...route } : null
  }

  async enter(input: EnterInput): Promise<PreviewSessionRecord | null> {
    this.calls.enter++
    const ticket = this.tickets.get(input.tokenHash)
    if (
      !ticket ||
      ticket.previewId !== input.previewId ||
      ticket.kind !== input.kind ||
      ticket.usedAt !== null ||
      ticket.expiresAt <= this.now()
    )
      return null
    ticket.usedAt = this.now()
    if (ticket.kind === 'user' && !this.members.has(ticket.userId ?? '')) return null
    const route = [...this.routes.values()].find((one) => one.id === input.previewId)!
    const id = `01960000-0000-7000-8000-${String(this.#next++).padStart(12, '0')}`
    const session: PreviewSessionRecord = {
      id,
      previewId: input.previewId,
      userId: ticket.userId,
      kind: ticket.kind,
      accessEpoch: route.accessEpoch,
      expiresAt: new Date(this.now() + 12 * 3_600_000),
      revokedAt: null,
      checkedAt: new Date(this.now()),
    }
    this.sessions.set(id, session)
    return { ...session }
  }

  async session(id: string): Promise<PreviewSessionRecord | null> {
    this.calls.session++
    const session = this.sessions.get(id)
    return session ? { ...session } : null
  }

  async recheck(sessionId: string): Promise<{ checkedAt: Date } | null> {
    this.calls.recheck++
    const session = this.sessions.get(sessionId)!
    if (session.kind === 'browser' || this.members.has(session.userId ?? '')) {
      session.checkedAt = new Date(this.now())
      return { checkedAt: session.checkedAt }
    }
    session.revokedAt = new Date(this.now())
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// A real upstream: the PHP of a preview stands behind it
// ---------------------------------------------------------------------------------------------

interface Upstream {
  server: Server
  port: number
  seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[]
  websockets: IncomingHttpHeaders[]
}

async function startUpstream(): Promise<Upstream> {
  const seen: Upstream['seen'] = []
  const websockets: IncomingHttpHeaders[] = []
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body: Buffer.concat(chunks).toString(),
      })
      if (request.url === '/framed') {
        response.writeHead(200, {
          'content-type': 'text/html',
          'x-frame-options': 'SAMEORIGIN',
          'content-security-policy': "frame-ancestors 'self'; img-src 'self'",
          'set-cookie': [
            'wordpress_test_cookie=WP; path=/; domain=.example.ru',
            `${PREVIEW_SESSION_COOKIE}=forged; Path=/; Secure`,
          ],
          'x-robots-tag': 'index',
        })
        response.end('<p>Привет</p>')
        return
      }
      if (request.url === '/moved') {
        response.writeHead(302, { location: 'https://example.ru/elsewhere' })
        response.end()
        return
      }
      if (request.url === '/slow') return // never answers
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`ok ${request.method} ${request.url}`)
    })
  })
  server.on('upgrade', (request: IncomingMessage, socket: Socket) => {
    websockets.push(request.headers)
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n' +
        'Sec-WebSocket-Accept: fake\r\nSet-Cookie: x=1; Domain=evil.example\r\n\r\n',
    )
    // Echoes, so the test sees both directions pass.
    socket.on('data', (chunk) => socket.write(chunk))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { server, port: (server.address() as AddressInfo).port, seen, websockets }
}

// ---------------------------------------------------------------------------------------------

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

let clock = T0
let store: MemoryAccess
let upstream: Upstream
let gateway: PreviewGatewayServer
let port = 0

async function startGateway(patch: Partial<PreviewGatewayOptions> = {}): Promise<void> {
  await gateway?.close()
  gateway = new PreviewGatewayServer({
    appEnv: 'development',
    address: { baseDomain: 'localhost', scheme: 'http', publicPort: 8090 },
    sessionSecret: SECRET,
    appUrl: APP,
    browserRelays: [{ address: '127.0.0.1', prefix: 32, family: 'ipv4' }],
    store,
    now: () => clock,
    ...patch,
  })
  port = (await gateway.listen(0, '127.0.0.1')).port
}

function send(
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path,
        headers: { host: `${HOST}:8090`, ...options.headers },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk: Buffer) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        )
      },
    )
    request.on('error', reject)
    request.end(options.body)
  })
}

/** Enters with a fresh ticket and gives back the cookie pair. */
async function enter(route: PreviewRoute, to = '/'): Promise<string> {
  const ticket = store.ticket(route)
  const answer = await send(`/__raditi/enter?t=${ticket}&to=${encodeURIComponent(to)}`)
  expect(answer.status).toBe(303)
  return String(answer.headers['set-cookie']?.[0]).split(';')[0]!
}

beforeEach(async () => {
  clock = T0
  store = new MemoryAccess(() => clock)
  upstream = await startUpstream()
  await startGateway()
})

afterEach(async () => {
  await gateway.close()
  upstream.server.closeAllConnections()
  upstream.server.close()
})

const serving = () => store.addRoute(HOST, { upstream: { host: '127.0.0.1', port: upstream.port } })

describe('PreviewGatewayServer: hosts', () => {
  it('answers its health with no-store, whatever the host', async () => {
    const answer = await send('/__raditi/health', { headers: { host: 'anything.example' } })
    expect(answer.status).toBe(200)
    expect(answer.headers['cache-control']).toBe('no-store')
    expect(JSON.parse(answer.body)).toEqual({ status: 'ok' })
  })

  it('knows a preview only by the exact Host, in Russian when it does not', async () => {
    serving()
    for (const host of [
      'example.ru',
      `${HOST}.evil.example`,
      `x.${HOST}`,
      'site-abcd1234-chat-ef5678.example.ru',
      OTHER,
    ]) {
      const answer = await send('/', { headers: { host } })
      expect(answer.status, host).toBe(404)
      expect(answer.body).toContain('Предпросмотр не найден')
      expect(answer.headers['content-security-policy']).toContain(`frame-ancestors ${APP}`)
    }
    // A client's forwarding headers never pick the preview.
    const forwarded = await send('/', {
      headers: { host: 'example.ru', 'x-forwarded-host': HOST, forwarded: `host=${HOST}` },
    })
    expect(forwarded.status).toBe(404)
    // Case and port are the browser's spelling, not another host.
    expect((await send('/', { headers: { host: `${HOST.toUpperCase()}:8090` } })).status).toBe(303)
    expect(upstream.seen).toEqual([])
  })

  it('reads the row of a host at most every five seconds', async () => {
    serving()
    await send('/')
    await send('/')
    expect(store.calls.route).toBe(1)
    clock += 5_000
    await send('/')
    expect(store.calls.route).toBe(2)
  })

  it('keeps its own paths: nothing under /__raditi/ reaches the site', async () => {
    serving()
    const answer = await send('/__raditi/other')
    expect(answer.status).toBe(404)
    expect(upstream.seen).toEqual([])
  })
})

describe('PreviewGatewayServer: tickets', () => {
  it('turns a ticket into its cookie and goes to the page on the row host', async () => {
    const route = serving()
    const ticket = store.ticket(route)
    const answer = await send(`/__raditi/enter?t=${ticket}&to=${encodeURIComponent('/about/?p=1')}`)
    expect(answer.status).toBe(303)
    expect(answer.headers.location).toBe(`${ORIGIN}/about/?p=1`)
    expect(answer.headers['referrer-policy']).toBe('no-referrer')
    expect(answer.headers['cache-control']).toBe('no-store')
    const [cookie] = answer.headers['set-cookie'] ?? []
    expect(cookie).toMatch(
      new RegExp(
        `^${PREVIEW_SESSION_COOKIE}=[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}; HttpOnly; Secure; SameSite=None; Partitioned; Path=/$`,
      ),
    )
    const [session] = [...store.sessions.values()]
    expect(session).toMatchObject({ previewId: route.id, kind: 'user', userId: 'user-1' })
  })

  it('opens one session per ticket', async () => {
    const route = serving()
    const ticket = store.ticket(route)
    expect((await send(`/__raditi/enter?t=${ticket}`)).status).toBe(303)
    const again = await send(`/__raditi/enter?t=${ticket}`)
    expect(again.status).toBe(403)
    expect(again.body).toContain('Ссылка на предпросмотр устарела')
    expect(again.headers['set-cookie']).toBeUndefined()
    expect(store.sessions.size).toBe(1)
  })

  it('asks the cabinet once for a fresh ticket when a frame came with a stale one', async () => {
    const route = serving()
    const stale = store.ticket(route, 'user', { expiresAt: clock })
    const framed = { 'sec-fetch-dest': 'iframe' }
    const first = await send(`/__raditi/enter?t=${stale}&to=%2Fshop%2F`, { headers: framed })
    expect(first.status).toBe(303)
    expect(first.headers.location).toBe(`${ORIGIN}/__raditi/frame-ticket?to=%2Fshop%2F`)
    expect(first.headers['set-cookie']).toEqual([
      '__Host-raditi-preview-retry=1; Max-Age=60; HttpOnly; Secure; SameSite=None; Partitioned; Path=/',
    ])
    const retry = '__Host-raditi-preview-retry=1'
    // A second refusal within the minute ends on the page: the frame never loops.
    const again = await send(`/__raditi/enter?t=${stale}&to=%2Fshop%2F`, {
      headers: { ...framed, cookie: retry },
    })
    expect(again.status).toBe(403)
    expect(again.body).toContain('Ссылка на предпросмотр устарела')
    // A fresh ticket opens the session and ends the retry.
    const entered = await send(`/__raditi/enter?t=${store.ticket(route)}&to=%2Fshop%2F`, {
      headers: { ...framed, cookie: retry },
    })
    expect(entered.status).toBe(303)
    expect(entered.headers.location).toBe(`${ORIGIN}/shop/`)
    expect(entered.headers['set-cookie']).toEqual([
      expect.stringMatching(/^__Host-raditi-preview=[0-9a-f-]{36}\./),
      expect.stringMatching(/^__Host-raditi-preview-retry=; Max-Age=0; /),
    ])
    // Outside a frame a refused ticket is the page at once.
    const top = await send(`/__raditi/enter?t=${stale}`)
    expect(top.status).toBe(403)
    expect(top.headers['set-cookie']).toBeUndefined()
  })

  it('takes a ticket only on the host of its preview, only within its minute', async () => {
    const route = serving()
    const other = store.addRoute(OTHER)
    const foreign = store.ticket(other)
    expect((await send(`/__raditi/enter?t=${foreign}`)).status).toBe(403)
    const late = store.ticket(route, 'user', { expiresAt: clock })
    expect((await send(`/__raditi/enter?t=${late}`)).status).toBe(403)
    // The agent's browser's ticket opens nothing for a visitor.
    const browser = store.ticket(route, 'browser')
    expect((await send(`/__raditi/enter?t=${browser}`)).status).toBe(403)
    // A user who left the workspace since.
    store.members.clear()
    expect((await send(`/__raditi/enter?t=${store.ticket(route)}`)).status).toBe(403)
    expect(store.sessions.size).toBe(0)
  })

  it('never redirects off the preview, and spends no ticket on a bad destination', async () => {
    const route = serving()
    const ticket = store.ticket(route)
    for (const to of [
      '//evil.example/',
      '/\\evil.example',
      '\\\\evil.example',
      'http://evil.example/',
      'https:evil.example',
      'javascript:alert(1)',
      '/a\r\nSet-Cookie: x=1',
      '/a\tb',
      '/#frag',
      'about',
      `/${'a'.repeat(2048)}`,
    ]) {
      const answer = await send(`/__raditi/enter?t=${ticket}&to=${encodeURIComponent(to)}`)
      expect(answer.status, to).toBe(400)
      expect(answer.body).toContain('Неверная ссылка на предпросмотр')
      expect(answer.headers.location).toBeUndefined()
    }
    for (const query of [`t=${ticket}&t=${ticket}`, `t=${ticket}&to=/&to=/x`, 't=short', ''])
      expect((await send(`/__raditi/enter?${query}`)).status, query).toBe(400)
    expect(store.calls.enter).toBe(0)
    expect((await send(`/__raditi/enter?t=${ticket}`)).headers.location).toBe(`${ORIGIN}/`)
  })

  it('takes GET only on its own paths', async () => {
    const route = serving()
    const answer = await send(`/__raditi/enter?t=${store.ticket(route)}`, { method: 'POST' })
    expect(answer.status).toBe(405)
    expect(store.calls.enter).toBe(0)
  })
})

describe('PreviewGatewayServer: sessions', () => {
  it('passes a visitor with the cookie to the site, and without it to the cabinet', async () => {
    const route = serving()
    const cookie = await enter(route)
    const inside = await send('/hello?x=1', { headers: { cookie } })
    expect(inside.status).toBe(200)
    expect(inside.body).toBe('ok GET /hello?x=1')

    const outside = await send('/hello?x=1')
    expect(outside.status).toBe(303)
    expect(outside.headers.location).toBe(
      `${APP}/preview/open?host=${HOST}&path=${encodeURIComponent('/hello?x=1')}`,
    )
    // A path the cabinet would refuse goes back as the home page.
    expect((await send('//double')).headers.location).toBe(
      `${APP}/preview/open?host=${HOST}&path=%2F`,
    )
  })

  it('refuses a cookie with another MAC, of another preview, expired, revoked or of an old epoch', async () => {
    const route = serving()
    const other = store.addRoute(OTHER, { upstream: route.upstream })
    const cookie = await enter(route)
    const [id] = [...store.sessions.keys()]
    const session = store.sessions.get(id!)!
    const blocked = async (pair: string) => (await send('/', { headers: { cookie: pair } })).status
    expect(await blocked(cookie)).toBe(200)
    expect(await blocked(`${cookie.slice(0, -2)}AA`)).toBe(303)
    // The same cookie on the other preview's host.
    const elsewhere = await send('/', { headers: { host: `${OTHER}:8090`, cookie } })
    expect(elsewhere.status).toBe(303)
    // A MAC made for the other host still names a row of this preview.
    const forged = `${PREVIEW_SESSION_COOKIE}=${previewCookieValue(SECRET, session, other.hostname)}`
    expect(await blocked(forged)).toBe(303)

    store.sessions.set(id!, { ...session, revokedAt: new Date(clock) })
    clock += 5_000
    expect(await blocked(cookie)).toBe(303)
    store.sessions.set(id!, { ...session, expiresAt: new Date(clock) })
    clock += 5_000
    expect(await blocked(cookie)).toBe(303)
    store.sessions.set(id!, { ...session, expiresAt: new Date(clock + 3_600_000) })
    store.routes.set(HOST, { ...route, accessEpoch: 1 })
    clock += 5_000
    expect(await blocked(cookie)).toBe(303)
  })

  it('checks membership again after a minute, once for parallel requests, and ends the session when it is gone', async () => {
    const route = serving()
    const cookie = await enter(route)
    clock += 59_000
    expect((await send('/', { headers: { cookie } })).status).toBe(200)
    expect(store.calls.recheck).toBe(0)
    clock += 2_000
    const answers = await Promise.all([1, 2, 3].map(() => send('/', { headers: { cookie } })))
    expect(answers.map((answer) => answer.status)).toEqual([200, 200, 200])
    expect(store.calls.recheck).toBe(1)
    store.members.clear()
    clock += 61_000
    expect((await send('/', { headers: { cookie } })).status).toBe(303)
    expect([...store.sessions.values()][0]?.revokedAt).not.toBeNull()
    store.members.add('user-1')
    expect((await send('/', { headers: { cookie } })).status).toBe(303)
  })

  it('asks the cabinet for a ticket from inside the iframe', async () => {
    serving()
    const answer = await send('/shop/?a=1', { headers: { 'sec-fetch-dest': 'iframe' } })
    expect(answer.status).toBe(303)
    expect(answer.headers.location).toBe(
      `${ORIGIN}/__raditi/frame-ticket?to=${encodeURIComponent('/shop/?a=1')}`,
    )
    const page = await send(`/__raditi/frame-ticket?to=${encodeURIComponent('/shop/?a=1')}`)
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    const policy = String(page.headers['content-security-policy'])
    const nonce = /script-src 'nonce-([^']+)'/.exec(policy)?.[1]
    expect(nonce).toBeTruthy()
    expect(policy).toContain("default-src 'none'")
    expect(policy).toContain(`frame-ancestors ${APP}`)
    expect(page.body).toContain(`<script nonce="${nonce}">`)
    expect(page.body).toContain(PREVIEW_TICKET_REQUEST)
    expect(page.body).toContain(JSON.stringify(APP))
    // It only asks: a ticket never comes into this window, where the site's scripts run too.
    expect(page.body).not.toContain('addEventListener')
    expect(page.body).not.toContain('location')
    expect(page.body).toContain('Открываем предпросмотр')
    // Nothing from outside: no external script, style, image or frame.
    expect(page.body).not.toMatch(/<(script|link|img|iframe)[^>]*\s(src|href)=/i)
    // A destination that would leave the host becomes the home page.
    const bad = await send(`/__raditi/frame-ticket?to=${encodeURIComponent('//evil.example')}`)
    expect(bad.body).toContain('"/"')
    expect(bad.body).not.toContain('evil.example')
  })

  it('sends a framed visitor who still has a session straight to the page', async () => {
    const route = serving()
    const cookie = await enter(route)
    const answer = await send('/__raditi/frame-ticket?to=%2Fshop%2F', { headers: { cookie } })
    expect(answer.status).toBe(303)
    expect(answer.headers.location).toBe(`${ORIGIN}/shop/`)
  })
})

describe('PreviewGatewayServer: the proxy', () => {
  it('rewrites what each side must not see or keep', async () => {
    const route = serving()
    const cookie = await enter(route)
    const answer = await send('/framed', {
      headers: {
        cookie: `wp=1; ${cookie}; ${REV}=1`,
        'x-forwarded-host': 'evil.example',
        'x-forwarded-for': '6.6.6.6',
      },
    })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('<p>Привет</p>')
    const [request] = upstream.seen
    expect(request?.headers.cookie).toBe('wp=1')
    expect(request?.headers.host).toBe(`${HOST}:8090`)
    expect(request?.headers['x-forwarded-host']).toBe(`${HOST}:8090`)
    expect(request?.headers['x-forwarded-proto']).toBe('http')
    expect(request?.headers['x-forwarded-for']).toBeUndefined()

    expect(answer.headers['x-frame-options']).toBeUndefined()
    expect(answer.headers['content-security-policy']).toBe(`img-src 'self', frame-ancestors ${APP}`)
    expect(answer.headers['set-cookie']).toEqual(['wordpress_test_cookie=WP; path=/'])
    expect(answer.headers['x-robots-tag']).toBe('noindex, nofollow')
  })

  it('follows no redirect of the site', async () => {
    const cookie = await enter(serving())
    const answer = await send('/moved', { headers: { cookie } })
    expect(answer.status).toBe(302)
    expect(answer.headers.location).toBe('https://example.ru/elsewhere')
    expect(upstream.seen).toHaveLength(1)
  })

  it('passes bodies and methods, refuses TRACE and a service worker registration', async () => {
    const cookie = await enter(serving())
    const posted = await send('/form', { method: 'POST', headers: { cookie }, body: 'a=1&b=2' })
    expect(posted.body).toBe('ok POST /form')
    expect(upstream.seen.at(-1)?.body).toBe('a=1&b=2')
    expect((await send('/x', { method: 'TRACE', headers: { cookie } })).status).toBe(405)
    const worker = await send('/sw.js', { headers: { cookie, 'service-worker': 'script' } })
    expect(worker.status).toBe(403)
    expect(upstream.seen.map((seen) => seen.url)).toEqual(['/form'])
  })

  it('clears the cache and storage once per revision the browser has not got, whatever the session', async () => {
    const route = serving()
    const cookie = await enter(route)
    const recorded = (revision: number) => expect.stringMatching(new RegExp(`^${REV}=${revision};`))
    // A browser that never got a revision of this preview: cleared, and the revision recorded.
    const first = await send('/', { headers: { cookie, 'sec-fetch-mode': 'navigate' } })
    expect(first.headers['clear-site-data']).toBe('"cache", "storage"')
    expect(first.headers['set-cookie']).toEqual([recorded(1)])
    const seen1 = `${cookie}; ${REV}=1`
    const again = await send('/', { headers: { cookie: seen1 } })
    expect(again.headers['clear-site-data']).toBeUndefined()
    expect(again.headers['set-cookie']).toBeUndefined()
    // What is not a document neither clears nor records anything.
    const asset = await send('/style.css', { headers: { cookie, 'sec-fetch-mode': 'no-cors' } })
    expect(asset.headers['clear-site-data']).toBeUndefined()
    expect(asset.headers['set-cookie']).toBeUndefined()

    store.routes.set(HOST, { ...route, revision: 2 })
    clock += 5_000
    // A new session — every frame of the cabinet opens one — still clears what this browser
    // kept of revision 1, then never again.
    const fresh = await enter(route)
    const changed = await send('/', { headers: { cookie: `${fresh}; ${REV}=1` } })
    expect(changed.headers['clear-site-data']).toBe('"cache", "storage"')
    expect(changed.headers['set-cookie']).toEqual([recorded(2)])
    const seen2 = await send('/', { headers: { cookie: `${fresh}; ${REV}=2` } })
    expect(seen2.headers['clear-site-data']).toBeUndefined()
    // The site never sees the gateway's record.
    expect(upstream.seen.at(-1)?.headers.cookie).toBeUndefined()
  })

  it('keeps the clear for the next answer of the site when the gateway answered itself', async () => {
    const route = serving()
    const cookie = `${await enter(route)}; ${REV}=1`
    store.routes.set(HOST, { ...route, revision: 2 })
    clock += 5_000
    upstream.server.closeAllConnections()
    upstream.server.close()
    await once(upstream.server, 'close')
    const failed = await send('/', { headers: { cookie } })
    expect(failed.status).toBe(502)
    expect(failed.headers['clear-site-data']).toBeUndefined()
    expect(failed.headers['set-cookie']).toBeUndefined()
    upstream = await startUpstream()
    store.routes.set(HOST, {
      ...route,
      revision: 2,
      upstream: { host: '127.0.0.1', port: upstream.port },
    })
    clock += 5_000
    const answered = await send('/', { headers: { cookie } })
    expect(answered.status).toBe(200)
    expect(answered.headers['clear-site-data']).toBe('"cache", "storage"')
  })

  it('refuses a request of a sibling host under the same registrable domain', async () => {
    const cookie = await enter(serving())
    const sibling = await send('/', { headers: { cookie, 'sec-fetch-site': 'same-site' } })
    expect(sibling.status).toBe(403)
    const ticket = await send(`/__raditi/enter?t=${'A'.repeat(43)}`, {
      headers: { 'sec-fetch-site': 'same-site' },
    })
    expect(ticket.status).toBe(403)
    for (const site of ['same-origin', 'cross-site', 'none'])
      expect((await send('/', { headers: { cookie, 'sec-fetch-site': site } })).status, site).toBe(
        200,
      )
    expect(upstream.seen).toHaveLength(3)
    expect(store.calls.enter).toBe(1)
  })

  it('tells a visitor in Russian when the preview is not running', async () => {
    const route = serving()
    const cookie = await enter(route)
    store.routes.set(HOST, { ...route, status: 'building' })
    clock += 5_000
    const building = await send('/', { headers: { cookie } })
    expect(building.status).toBe(503)
    expect(building.body).toContain('Предпросмотр готовится')
    expect(building.body).toContain('http-equiv="refresh"')
    store.routes.set(HOST, { ...route, status: 'failed' })
    clock += 5_000
    const failed = await send('/', { headers: { cookie } })
    expect(failed.body).toContain('Предпросмотр сейчас недоступен')
    expect(upstream.seen).toEqual([])
  })

  it('connects only to an IP literal, a private or loopback one in production', async () => {
    const route = store.addRoute(HOST, { upstream: { host: 'localhost', port: upstream.port } })
    const cookie = await enter(route)
    expect((await send('/', { headers: { cookie } })).status).toBe(503)
    expect(upstream.seen).toEqual([])
  })

  it('refuses a declared body over the limit without reading it', async () => {
    const cookie = await enter(serving())
    const answer = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          `POST /upload HTTP/1.1\r\nHost: ${HOST}:8090\r\nCookie: ${cookie}\r\n` +
            `Content-Length: ${64 * 1024 * 1024}\r\n\r\n`,
        )
      })
      let text = ''
      socket.on('data', (chunk) => (text += chunk.toString()))
      socket.on('close', () => resolve(text))
      socket.on('error', () => resolve(text))
    })
    expect(answer).toMatch(/^HTTP\/1\.1 413 /)
    expect(upstream.seen).toEqual([])
  })

  it('says the site did not answer', async () => {
    const route = serving()
    const cookie = await enter(route)
    upstream.server.closeAllConnections()
    upstream.server.close()
    await once(upstream.server, 'close')
    const answer = await send('/', { headers: { cookie } })
    expect(answer.status).toBe(502)
    expect(answer.body).toContain('Сайт в предпросмотре не ответил')
    upstream = await startUpstream()
  })
})

describe('PreviewGatewayServer: the agent browser through a relay', () => {
  const absolute = (path: string) => `${ORIGIN}${path}`

  it('enters with a browser ticket in absolute form and reaches only that preview', async () => {
    const route = serving()
    const ticket = store.ticket(route, 'browser')
    const entered = await send(absolute(`/__raditi/enter?t=${ticket}`))
    expect(entered.status).toBe(303)
    const cookie = String(entered.headers['set-cookie']?.[0]).split(';')[0]!
    expect([...store.sessions.values()][0]).toMatchObject({ kind: 'browser', userId: null })

    const page = await send(absolute('/shop/'), {
      headers: { cookie, 'proxy-connection': 'keep-alive' },
    })
    expect(page.status).toBe(200)
    expect(page.body).toBe('ok GET /shop/')
    expect(upstream.seen.at(-1)?.headers['proxy-connection']).toBeUndefined()
    // The browser's cookie is no visitor's: origin form does not take it.
    expect((await send('/shop/', { headers: { cookie } })).status).toBe(303)
    // Another preview, without a session there: no redirect anywhere, just no.
    store.addRoute(OTHER, { upstream: route.upstream })
    const other = await send(`http://${OTHER}:8090/`, { headers: { cookie } })
    expect(other.status).toBe(403)
  })

  it('is no open proxy: foreign hosts, other ports, https and strangers are refused', async () => {
    const route = serving()
    const cookie = await enter(route)
    for (const url of [
      'http://example.ru/',
      'http://127.0.0.1:3000/',
      `http://${HOST}:3000/`,
      `http://${HOST}/`,
      `http://user:pw@${HOST}:8090/`,
      `https://${HOST}:8090/`,
      'http://localhost:8090/',
    ])
      expect((await send(url, { headers: { cookie } })).status, url).toBe(403)
    // A visitor's session never comes through a relay either.
    expect((await send(absolute('/'), { headers: { cookie } })).status).toBe(403)
    await startGateway({ browserRelays: [] })
    const ticket = store.ticket(route, 'browser')
    expect((await send(absolute(`/__raditi/enter?t=${ticket}`))).status).toBe(403)
    expect(store.calls.enter).toBe(1)
    expect(upstream.seen).toEqual([])
  })

  it('never tunnels: CONNECT is refused', async () => {
    serving()
    const answer = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () =>
        socket.write(`CONNECT ${HOST}:8090 HTTP/1.1\r\nHost: ${HOST}:8090\r\n\r\n`),
      )
      let text = ''
      socket.on('data', (chunk) => (text += chunk.toString()))
      socket.on('close', () => resolve(text))
    })
    expect(answer).toMatch(/^HTTP\/1\.1 405 /)
  })
})

describe('PreviewGatewayServer: websockets', () => {
  async function handshake(cookie: string | null, host = `${HOST}:8090`, extra = '') {
    const socket = connect(port, '127.0.0.1')
    await once(socket, 'connect')
    socket.write(
      `GET /ws HTTP/1.1\r\nHost: ${host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
        `Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n` +
        (cookie ? `Cookie: wp=1; ${cookie}\r\n` : '') +
        extra +
        '\r\n',
    )
    let text = ''
    const head = new Promise<string>((resolve) => {
      socket.on('data', (chunk) => {
        text += chunk.toString()
        if (text.includes('\r\n\r\n')) resolve(text)
      })
      socket.on('close', () => resolve(text))
    })
    return { socket, head: await head, more: () => text }
  }

  it('passes the handshake and the frames to the same upstream, without the gateway cookie', async () => {
    const cookie = await enter(serving())
    const { socket, head, more } = await handshake(cookie)
    expect(head).toMatch(/^HTTP\/1\.1 101 /)
    expect(head).toMatch(/\r\nupgrade: websocket\r\n/i)
    expect(head).toContain('sec-websocket-accept: fake')
    expect(head).toContain('set-cookie: x=1\r\n')
    expect(upstream.websockets[0]?.cookie).toBe('wp=1')
    expect(upstream.websockets[0]?.host).toBe(`${HOST}:8090`)
    socket.write('ping')
    await new Promise<void>((resolve) => {
      const check = () => (more().endsWith('ping') ? resolve() : setTimeout(check, 5))
      check()
    })
    socket.destroy()
  })

  /** Resolves once the echo of `text` came back through the tunnel. */
  async function echoed(tunnel: { socket: Socket; more: () => string }, text: string) {
    tunnel.socket.write(text)
    await new Promise<void>((resolve) => {
      const check = () => (tunnel.more().endsWith(text) ? resolve() : setTimeout(check, 5))
      check()
    })
  }

  it('checks an open websocket again and closes it once its session may not go on', async () => {
    const route = serving()
    const tunnel = await handshake(await enter(route))
    expect(tunnel.head).toMatch(/^HTTP\/1\.1 101 /)
    // A minute on, still a member: the check asks the database once and the tunnel stays.
    clock += 61_000
    await gateway.recheckTunnels()
    expect(store.calls.recheck).toBe(1)
    await echoed(tunnel, 'still')
    // Out of the workspace: closed at the next check, both ways.
    store.members.clear()
    clock += 61_000
    const closed = once(tunnel.socket, 'close')
    await gateway.recheckTunnels()
    await closed

    // A new access epoch (a reset, a revocation) ends a tunnel the same way.
    store.members.add('user-1')
    const other = await handshake(await enter(route))
    expect(other.head).toMatch(/^HTTP\/1\.1 101 /)
    store.routes.set(HOST, { ...route, accessEpoch: 1 })
    clock += 5_000
    const ended = once(other.socket, 'close')
    await gateway.recheckTunnels()
    await ended
  })

  it('closes a websocket whose preview stopped or moved', async () => {
    const route = serving()
    const tunnel = await handshake(await enter(route))
    expect(tunnel.head).toMatch(/^HTTP\/1\.1 101 /)
    store.routes.set(HOST, { ...route, upstream: { host: '127.0.0.1', port: 1 } })
    clock += 5_000
    const closed = once(tunnel.socket, 'close')
    await gateway.recheckTunnels()
    await closed
  })

  it('refuses an upgrade without a session, of an unknown host or of a sibling site', async () => {
    const route = serving()
    const anonymous = await handshake(null)
    expect(anonymous.head).toMatch(/^HTTP\/1\.1 403 /)
    const unknown = await handshake(null, 'example.ru')
    expect(unknown.head).toMatch(/^HTTP\/1\.1 404 /)
    const sibling = await handshake(await enter(route), undefined, 'Sec-Fetch-Site: same-site\r\n')
    expect(sibling.head).toMatch(/^HTTP\/1\.1 403 /)
    expect(upstream.websockets).toEqual([])
  })
})
