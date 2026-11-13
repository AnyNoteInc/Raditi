import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ServedPage } from '@repo/db'
import {
  newPageSlug,
  PAGE_CSP,
  PAGE_PLATFORM_CSP,
  PAGE_READING_CSP,
  pageLimits,
} from '@repo/domain'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { pageSetCookie } from './page-cookie.ts'
import { PagesServer, viewerOf, type PagesStore } from './pages-server.ts'

const BASE = 'pages.localhost'
const PORT_IN_HOST = 8092
const SECRET = 'test-pages-cookie-secret-of-32-characters-at-least'
const slugOf = (fill: number) => newPageSlug(() => new Uint8Array(16).fill(fill))
const open = slugOf(1)
const locked = slugOf(2)
const down = slugOf(3)
const writing = slugOf(4)
const pending = slugOf(5)
const reading = slugOf(6)

class MemoryStore implements PagesStore {
  pages = new Map<string, ServedPage>()
  counts = new Map<string, number>()
  served(slug: string) {
    return Promise.resolve(this.pages.get(slug) ?? null)
  }
  admit(key: string, limit: number) {
    const count = (this.counts.get(key) ?? 0) + 1
    this.counts.set(key, count)
    return Promise.resolve(count <= limit)
  }
  verify(password: string, hash: string) {
    return Promise.resolve(hash === `hash:${password}`)
  }
}

const page = (id: string, extra: Partial<ServedPage> = {}): ServedPage => ({
  id,
  state: 'live',
  kind: 'html',
  passwordHash: null,
  passwordEpoch: 0,
  content: { version: 3, bytes: new TextEncoder().encode(`<p>${id}</p>`) },
  ...extra,
})

interface Answer {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

describe('the server of published pages', () => {
  let store: MemoryStore
  let server: PagesServer
  let port: number

  const call = (
    host: string,
    options: {
      method?: string
      path?: string
      headers?: Record<string, string>
      body?: string
    } = {},
  ) =>
    new Promise<Answer>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: options.method ?? 'GET',
          path: options.path ?? '/',
          headers: { host, ...options.headers },
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => chunks.push(chunk))
          response.on('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          )
        },
      )
      outgoing.on('error', reject)
      outgoing.end(options.body)
    })
  const hostOf = (slug: string) => `${slug}.${BASE}:${PORT_IN_HOST}`
  const form = (password: string, headers: Record<string, string> = {}) => ({
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams({ password }).toString(),
  })

  beforeEach(async () => {
    store = new MemoryStore()
    store.pages.set(open, page('00000000-0000-7000-8000-000000000001'))
    store.pages.set(
      locked,
      page('00000000-0000-7000-8000-000000000002', {
        passwordHash: 'hash:секрет-1',
        passwordEpoch: 4,
      }),
    )
    store.pages.set(down, page('00000000-0000-7000-8000-000000000003', { state: 'taken_down' }))
    store.pages.set(
      writing,
      page('00000000-0000-7000-8000-000000000004', {
        state: 'pending',
        kind: 'doc',
        content: null,
      }),
    )
    store.pages.set(
      pending,
      page('00000000-0000-7000-8000-000000000005', { state: 'pending', content: null }),
    )
    store.pages.set(reading, page('00000000-0000-7000-8000-000000000006', { kind: 'doc' }))
    server = new PagesServer({
      config: {
        baseDomain: BASE,
        publicPort: PORT_IN_HOST,
        cookieSecret: SECRET,
        abuseEmail: 'abuse@example.test',
      },
      store,
      clock: () => 1_800_000_000_000,
    })
    port = ((await server.listen(0, '127.0.0.1')) as AddressInfo).port
  })
  afterEach(() => server.close())

  it('serves the current version of a page under its sandbox', async () => {
    const answer = await call(hostOf(open))
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('<p>00000000-0000-7000-8000-000000000001</p>')
    expect(answer.headers['content-security-policy']).toBe(PAGE_CSP)
    expect(answer.headers['x-content-type-options']).toBe('nosniff')
    expect(answer.headers['x-robots-tag']).toBe('noindex, nofollow, noarchive')
    expect(answer.headers['set-cookie']).toBeUndefined()
    expect(answer.headers['cache-control']).toBe('private, no-cache')
  })

  it('serves a document without scripts', async () => {
    expect((await call(hostOf(reading))).headers['content-security-policy']).toBe(PAGE_READING_CSP)
  })

  it('answers HEAD with the headers alone', async () => {
    const answer = await call(hostOf(open), { method: 'HEAD' })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('')
    expect(Number(answer.headers['content-length'])).toBeGreaterThan(0)
  })

  it('answers no other host, path or method', async () => {
    for (const host of [
      `${BASE}:${PORT_IN_HOST}`,
      `${open}.${BASE}`.replace(BASE, 'raditi.ru'),
      `a.${open}.${BASE}:${PORT_IN_HOST}`,
      `${open}.${BASE}:9999`,
      'localhost',
    ]) {
      const answer = await call(host)
      expect(answer.status, host).toBe(404)
      expect(answer.body).not.toContain('<p>')
    }
    expect((await call(hostOf(open), { path: '/v2' })).status).toBe(404)
    expect((await call(hostOf(open), { path: '/admin' })).status).toBe(404)
    const put = await call(hostOf(open), { method: 'PUT' })
    expect(put.status).toBe(405)
    expect(put.headers.allow).toBe('GET, HEAD, POST')
    // A page without a password takes no form.
    expect((await call(hostOf(open), form('x'))).status).toBe(405)
  })

  it('takes a query on the page itself', async () => {
    expect((await call(hostOf(open), { path: '/?utm=1' })).status).toBe(200)
  })

  it('forbids indexing everywhere', async () => {
    const answer = await call(hostOf(open), { path: '/robots.txt' })
    expect(answer.status).toBe(200)
    expect(answer.body).toBe('User-agent: *\nDisallow: /\n')
  })

  it('answers 410 for a page taken down, 404 for one that never was', async () => {
    const gone = await call(hostOf(down))
    expect(gone.status).toBe(410)
    expect(gone.body).toContain('Страница снята с публикации')
    expect(gone.body).toContain('abuse@example.test')
    expect(gone.headers['content-security-policy']).toBe(PAGE_PLATFORM_CSP)
    expect((await call(hostOf(pending))).status).toBe(404)
    expect((await call(hostOf(slugOf(9)))).status).toBe(404)
  })

  it('says a document is still being written', async () => {
    const answer = await call(hostOf(writing))
    expect(answer.status).toBe(200)
    expect(answer.body).toContain('Документ ещё пишется')
  })

  it('asks for the password, refuses a wrong one and opens with the right one', async () => {
    const ask = await call(hostOf(locked))
    expect(ask.status).toBe(200)
    expect(ask.body).toContain('Страница закрыта паролем')
    expect(ask.body).not.toContain('<p>00000000')
    expect(ask.headers['cache-control']).toBe('no-store')

    const wrong = await call(hostOf(locked), form('не тот'))
    expect(wrong.status).toBe(200)
    expect(wrong.body).toContain('Пароль не подошёл')
    expect(wrong.headers['set-cookie']).toBeUndefined()

    const right = await call(hostOf(locked), form('секрет-1'))
    expect(right.status).toBe(303)
    expect(right.headers.location).toBe('/')
    const cookie = String(right.headers['set-cookie'])
    expect(cookie).toMatch(
      /^raditi_page=4\.\d{13}\.[A-Za-z0-9_-]{43}; Max-Age=43200; HttpOnly; Secure; SameSite=Lax; Path=\/$/,
    )
    expect(cookie).not.toMatch(/Domain=/i)

    const opened = await call(hostOf(locked), { headers: { cookie: cookie.split(';')[0]! } })
    expect(opened.status).toBe(200)
    expect(opened.body).toBe('<p>00000000-0000-7000-8000-000000000002</p>')
  })

  it('does not open the page with the cookie of another page or of a former password', async () => {
    const right = await call(hostOf(locked), form('секрет-1'))
    const cookie = String(right.headers['set-cookie']).split(';')[0]!
    // A new password: the epoch grows, the former cookie stops.
    store.pages.set(locked, { ...store.pages.get(locked)!, passwordEpoch: 5 })
    expect((await call(hostOf(locked), { headers: { cookie } })).body).toContain('закрыта паролем')
    const other = slugOf(7)
    store.pages.set(
      other,
      page('00000000-0000-7000-8000-000000000007', {
        passwordHash: 'hash:секрет-1',
        passwordEpoch: 4,
      }),
    )
    expect((await call(hostOf(other), { headers: { cookie } })).body).toContain('закрыта паролем')
  })

  it('limits the attempts of an address and refuses a large or foreign form', async () => {
    for (let attempt = 0; attempt < pageLimits.passwordAttemptsPerAddress; attempt += 1)
      expect((await call(hostOf(locked), form('нет'))).status).toBe(200)
    const blocked = await call(hostOf(locked), form('секрет-1'))
    expect(blocked.status).toBe(429)
    expect(blocked.body).toContain('Слишком много попыток')

    expect(
      (
        await call(hostOf(locked), {
          ...form('x'),
          body: 'password=' + 'a'.repeat(pageLimits.passwordFormBytes),
        })
      ).status,
    ).toBe(413)
    expect(
      (
        await call(hostOf(locked), {
          ...form('x'),
          headers: { 'content-type': 'application/json' },
        })
      ).status,
    ).toBe(415)
  })
  it('stops the attempts of one address without spending the page for others', async () => {
    const from = (address: string) => ({ 'x-forwarded-for': `10.0.0.9, ${address}` })
    for (let attempt = 0; attempt < pageLimits.passwordAttemptsPerAddress + 5; attempt += 1)
      await call(hostOf(locked), form('нет', from('203.0.113.1')))
    const blocked = await call(hostOf(locked), form('секрет-1', from('203.0.113.1')))
    expect(blocked.status).toBe(429)
    expect(blocked.headers['retry-after']).toBe(
      String(pageLimits.passwordAttemptsPerAddressWindowSeconds),
    )
    // The page's counter got only the attempts the address was allowed.
    expect(store.counts.get('page-password:00000000-0000-7000-8000-000000000002')).toBe(
      pageLimits.passwordAttemptsPerAddress,
    )
    expect((await call(hostOf(locked), form('секрет-1', from('203.0.113.2')))).status).toBe(303)
  })

  it('stops every address once the page has had its attempts of the hour', async () => {
    store.counts.set(
      'page-password:00000000-0000-7000-8000-000000000002',
      pageLimits.passwordAttemptsPerPage,
    )
    const answer = await call(
      hostOf(locked),
      form('секрет-1', { 'x-forwarded-for': '203.0.113.7' }),
    )
    expect(answer.status).toBe(429)
    expect(answer.headers['retry-after']).toBe(
      String(pageLimits.passwordAttemptsPerPageWindowSeconds),
    )
  })

  it('opens with no expired or forged cookie', async () => {
    const lockedPage = { id: '00000000-0000-7000-8000-000000000002', passwordEpoch: 4 }
    const expired = pageSetCookie(SECRET, lockedPage, 1_800_000_000_000 - 60_000, 30).split(';')[0]!
    expect((await call(hostOf(locked), { headers: { cookie: expired } })).body).toContain(
      'закрыта паролем',
    )
    const forged = pageSetCookie(
      'another-secret-of-thirty-two-characters!!',
      lockedPage,
      1_800_000_000_000,
      60,
    ).split(';')[0]!
    expect((await call(hostOf(locked), { headers: { cookie: forged } })).body).toContain(
      'закрыта паролем',
    )
  })

  it('takes no form at a page taken down or never published, and answers HEAD of a stub', async () => {
    expect((await call(hostOf(down), form('секрет-1'))).status).toBe(410)
    expect((await call(hostOf(pending), form('секрет-1'))).status).toBe(404)
    const head = await call(hostOf(slugOf(9)), { method: 'HEAD' })
    expect(head.status).toBe(404)
    expect(head.body).toBe('')
  })

  it('says too long a form in Russian', async () => {
    const answer = await call(hostOf(locked), {
      ...form('x'),
      body: 'password=' + 'a'.repeat(pageLimits.passwordFormBytes),
    })
    expect(answer.status).toBe(413)
    expect(answer.body).toContain('Пароль слишком длинный')
  })
})

describe('the address of a viewer', () => {
  const request = (remoteAddress: string, forwarded?: string) =>
    ({
      socket: { remoteAddress },
      headers: forwarded ? { 'x-forwarded-for': forwarded } : {},
    }) as never

  it('believes X-Forwarded-For from a private or loopback neighbour only, by its last hop', () => {
    expect(viewerOf(request('10.10.0.10', '1.1.1.1, 203.0.113.5'))).toBe('203.0.113.5')
    expect(viewerOf(request('::ffff:127.0.0.1', '203.0.113.5'))).toBe('203.0.113.5')
    expect(viewerOf(request('198.51.100.4', '203.0.113.5'))).toBe('198.51.100.4')
    expect(viewerOf(request('10.10.0.10'))).toBe('10.10.0.10')
  })
})
