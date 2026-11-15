import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ServedNode, ServedSite } from '@repo/db'
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

/**
 * A site of the test as one flat row (docs/plan/73-pages-sites.md, Дер11): its home page and the
 * site in one — taken down or in the trash is the site's —, with the pages below it and the
 * former paths that send on.
 */
interface FlatSite {
  id: string
  state: 'pending' | 'live' | 'taken_down'
  deleted: boolean
  kind: ServedNode['kind']
  passwordHash: string | null
  passwordEpoch: number
  content: ServedNode['content']
  nodes?: Record<string, ServedNode>
  redirects?: Record<string, string>
  /** The label to send on to: its own name, asked by another label (Дер32). */
  host?: string | null
}

class MemoryStore implements PagesStore {
  pages = new Map<string, FlatSite>()
  files = new Map<string, { type: string; bytes: Uint8Array; sha256: string }>()
  file(treeId: string, path: string) {
    return Promise.resolve(this.files.get(`${treeId}${path}`) ?? null)
  }
  counts = new Map<string, number>()
  asked: string[] = []
  served(slug: string, path: string): Promise<ServedSite | null> {
    this.asked.push(path)
    const site = this.pages.get(slug)
    if (!site) return Promise.resolve(null)
    const home: ServedNode = {
      id: site.id,
      state: site.state === 'taken_down' ? 'live' : site.state,
      deleted: false,
      kind: site.kind,
      content: site.content,
    }
    return Promise.resolve({
      treeId: site.id,
      host: site.host ?? null,
      gone: site.state === 'taken_down' ? 'taken_down' : site.deleted ? 'deleted' : null,
      passwordHash: site.passwordHash,
      passwordEpoch: site.passwordEpoch,
      page: path === '/' ? home : (site.nodes?.[path] ?? null),
      redirect: site.redirects?.[path] ?? null,
    })
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

const page = (id: string, extra: Partial<FlatSite> = {}): FlatSite => ({
  id,
  state: 'live',
  deleted: false,
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

  it('answers 410 «Страница удалена» for a page in the trash, before its password (plan 73, Дер2)', async () => {
    const trashed = slugOf(10)
    store.pages.set(
      trashed,
      page('00000000-0000-7000-8000-00000000000a', {
        deleted: true,
        passwordHash: 'hash:секрет-1',
        content: null,
      }),
    )
    const gone = await call(hostOf(trashed))
    expect(gone.status).toBe(410)
    expect(gone.body).toContain('Страница удалена')
    expect(gone.body).not.toContain('Пароль')
    expect(gone.headers['content-security-policy']).toBe(PAGE_PLATFORM_CSP)
    expect((await call(hostOf(trashed), form('секрет-1'))).status).toBe(410)
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
      /^raditi_page=4\.\d{13}\.[A-Za-z0-9_-]{43}; Max-Age=43200; HttpOnly; Secure; SameSite=None; Path=\/$/,
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
  // ——————————————————— a site of pages (docs/plan/73-pages-sites.md, Дер15–Дер19, §5.2)

  describe('a site of pages', () => {
    const site = slugOf(20)
    const node = (id: number, extra: Partial<ServedNode> = {}): ServedNode => ({
      id: `00000000-0000-7000-8000-0000000002${String(id).padStart(2, '0')}`,
      state: 'live',
      deleted: false,
      kind: 'html',
      content: { version: 1, bytes: new TextEncoder().encode(`<p>node ${id}</p>`) },
      ...extra,
    })
    beforeEach(() => {
      store.pages.set(
        site,
        page('00000000-0000-7000-8000-000000000200', {
          nodes: {
            '/uslugi': node(1),
            '/uslugi/remont': node(2, {
              content: { version: 4, bytes: new TextEncoder().encode('<p>remont</p>') },
            }),
            '/staroe': node(3, { deleted: true, content: null }),
            '/snyato': node(4, { state: 'taken_down' }),
            '/chernovik': node(5, { state: 'pending', content: null }),
          },
          redirects: { '/ceny': '/uslugi/remont', '/staroe': '/uslugi' },
        }),
      )
    })

    it('serves a page at its path under the policy of a page', async () => {
      const answer = await call(hostOf(site), { path: '/uslugi/remont' })
      expect(answer.status).toBe(200)
      expect(answer.body).toBe('<p>remont</p>')
      expect(answer.headers['content-security-policy']).toBe(PAGE_CSP)
      expect(store.asked.at(-1)).toBe('/uslugi/remont')
    })

    it('sends a slash at the end and capital letters on to the canon, the request never as it came', async () => {
      for (const [path, location] of [
        ['/uslugi/', '/uslugi'],
        ['/USLUGI/Remont', '/uslugi/remont'],
      ] as const) {
        const answer = await call(hostOf(site), { path })
        expect(answer.status, path).toBe(308)
        expect(answer.headers.location).toBe(location)
        expect(answer.body).toBe('')
      }
    })

    it('answers 404 without a lookup for a path that is no path', async () => {
      for (const path of ['/%2e%2e/x', '/a//b', '/index.html', '/v2.html', '/a;b', '/-a']) {
        store.asked = []
        const answer = await call(hostOf(site), { path })
        expect(answer.status, path).toBe(404)
        expect(store.asked).toEqual(['/'])
      }
    })

    it('sends a former path on to where its page is now, 308 with no chain (Дер19)', async () => {
      const moved = await call(hostOf(site), { path: '/ceny' })
      expect(moved.status).toBe(308)
      expect(moved.headers.location).toBe('/uslugi/remont')
    })

    it('answers 410 at a page in the trash, a redirect taking a path its page left first', async () => {
      // /staroe is in the trash, and a redirect now sends it on: the redirect wins.
      const sent = await call(hostOf(site), { path: '/staroe' })
      expect(sent.status).toBe(308)
      store.pages.get(site)!.redirects = {}
      const gone = await call(hostOf(site), { path: '/staroe' })
      expect(gone.status).toBe(410)
      expect(gone.body).toContain('Страница удалена')
    })

    it('answers 410 at a page taken down alone, 404 at a page never published', async () => {
      expect((await call(hostOf(site), { path: '/snyato' })).status).toBe(410)
      expect((await call(hostOf(site), { path: '/chernovik' })).status).toBe(404)
      expect((await call(hostOf(site), { path: '/net-takoy' })).status).toBe(404)
    })

    it('answers 410 on every path of a site taken down or in the trash', async () => {
      store.pages.get(site)!.state = 'taken_down'
      for (const path of ['/', '/uslugi', '/net-takoy'])
        expect((await call(hostOf(site), { path })).status, path).toBe(410)
      store.pages.get(site)!.state = 'live'
      store.pages.get(site)!.deleted = true
      const gone = await call(hostOf(site), { path: '/uslugi' })
      expect(gone.status).toBe(410)
      expect(gone.body).toContain('Страница удалена')
    })

    it('asks the password of the site before any page, a path that is not there too (Дер16)', async () => {
      Object.assign(store.pages.get(site)!, { passwordHash: 'hash:секрет-1', passwordEpoch: 2 })
      for (const path of ['/uslugi', '/net-takoy', '/staroe', '/USLUGI', '/%2e%2e']) {
        const answer = await call(hostOf(site), { path })
        expect(answer.status, path).toBe(200)
        expect(answer.body).toContain('Страница закрыта паролем')
      }
      // The form posts to the canonical path it was asked at, 303 back there with the cookie.
      expect((await call(hostOf(site), { path: '/uslugi/remont' })).body).toContain(
        'action="/uslugi/remont"',
      )
      expect((await call(hostOf(site), { path: '/%2e%2e' })).body).toContain('action="/"')
      const right = await call(hostOf(site), { ...form('секрет-1'), path: '/uslugi/remont' })
      expect(right.status).toBe(303)
      expect(right.headers.location).toBe('/uslugi/remont')
      const cookie = String(right.headers['set-cookie']).split(';')[0]!
      const opened = await call(hostOf(site), { path: '/uslugi/remont', headers: { cookie } })
      expect(opened.body).toBe('<p>remont</p>')
      // One password for the site: the same cookie opens its other pages.
      expect((await call(hostOf(site), { path: '/uslugi', headers: { cookie } })).status).toBe(200)
      expect((await call(hostOf(site), { path: '/net-takoy', headers: { cookie } })).status).toBe(
        404,
      )
    })

    it('opens a site with the cookie a viewer got before sites — its id is the page’s (Дер13)', async () => {
      Object.assign(store.pages.get(site)!, { passwordHash: 'hash:секрет-1', passwordEpoch: 7 })
      const cookie = pageSetCookie(
        SECRET,
        { id: '00000000-0000-7000-8000-000000000200', passwordEpoch: 7 },
        1_800_000_000_000,
        pageLimits.passwordCookieSeconds,
      ).split(';')[0]!
      expect((await call(hostOf(site), { headers: { cookie } })).status).toBe(200)
    })

    it('says a version was seen with 304, and names it by its ETag (Дер22)', async () => {
      const first = await call(hostOf(site), { path: '/uslugi/remont' })
      const etag = String(first.headers.etag)
      expect(etag).toBe('"00000000-0000-7000-8000-000000000202.4"')
      const again = await call(hostOf(site), {
        path: '/uslugi/remont',
        headers: { 'if-none-match': etag },
      })
      expect(again.status).toBe(304)
      expect(again.body).toBe('')
      expect(again.headers['content-security-policy']).toBe(PAGE_CSP)
    })

    it('takes no form at a page without a password, and tells nothing at a path that is not there', async () => {
      expect((await call(hostOf(site), { ...form('x'), path: '/uslugi' })).status).toBe(405)
      expect((await call(hostOf(site), { ...form('x'), path: '/net-takoy' })).status).toBe(404)
      expect((await call(hostOf(site), { ...form('x'), path: '/chernovik' })).status).toBe(404)
    })
  })

  it('sends a site asked by its slug or a former name on to its own name, at the same path (Дер32)', async () => {
    store.pages.set(open, { ...store.pages.get(open)!, host: 'moya-firma' })
    const moved = await call(hostOf(open), { path: '/Uslugi/' })
    expect(moved.status).toBe(308)
    expect(moved.headers.location).toBe(`//moya-firma.${BASE}:${PORT_IN_HOST}/uslugi`)
    const odd = await call(hostOf(open), { path: '/%2e%2e' })
    expect(odd.headers.location).toBe(`//moya-firma.${BASE}:${PORT_IN_HOST}/`)
  })

  // ——————————————————— shared files of a site (docs/plan/73-pages-sites.md, Дер34, Дер35)

  describe('shared files of a site', () => {
    const id = '00000000-0000-7000-8000-000000000001'
    const css = {
      type: 'text/css; charset=utf-8',
      bytes: new TextEncoder().encode('a{}'),
      sha256: 'c'.repeat(64),
    }
    beforeEach(() => {
      store.files.set(`${id}/_files/style.css`, css)
    })

    it('serves a file with its own type, loadable by any page, running nothing alone', async () => {
      const answer = await call(hostOf(open), { path: '/_files/style.css' })
      expect(answer.status).toBe(200)
      expect(answer.body).toBe('a{}')
      expect(answer.headers).toMatchObject({
        'content-type': 'text/css; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'cross-origin',
        etag: `"${'c'.repeat(64)}"`,
      })
      expect(answer.headers['content-security-policy']).toContain('sandbox')
      const again = await call(hostOf(open), {
        path: '/_files/style.css',
        headers: { 'if-none-match': `"${'c'.repeat(64)}"` },
      })
      expect(again.status).toBe(304)
    })

    it('answers 404 for no file, a path that is none and a page of HTML; 405 for a form', async () => {
      for (const path of [
        '/_files/net.css',
        '/_files/index.html',
        '/_files/../x.css',
        '/_files/A.css',
      ])
        expect((await call(hostOf(open), { path })).status, path).toBe(404)
      expect((await call(hostOf(open), { ...form('x'), path: '/_files/style.css' })).status).toBe(
        405,
      )
    })

    it('gives a file of a site with a password only with its cookie, and none of a site gone', async () => {
      const lockedId = '00000000-0000-7000-8000-000000000002'
      store.files.set(`${lockedId}/_files/style.css`, css)
      expect((await call(hostOf(locked), { path: '/_files/style.css' })).status).toBe(404)
      const right = await call(hostOf(locked), form('секрет-1'))
      const cookie = String(right.headers['set-cookie']).split(';')[0]!
      expect(
        (await call(hostOf(locked), { path: '/_files/style.css', headers: { cookie } })).status,
      ).toBe(200)
      const downId = '00000000-0000-7000-8000-000000000003'
      store.files.set(`${downId}/_files/style.css`, css)
      expect((await call(hostOf(down), { path: '/_files/style.css' })).status).toBe(410)
    })
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
