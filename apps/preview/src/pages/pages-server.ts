import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ServedSiteMeta, ServedTree } from '@repo/db'
import { isLoopbackAddress, isPrivateAddress } from '@repo/ip-address'
import {
  PAGE_METHODS,
  PAGE_ROBOTS_TXT,
  PAGE_COMMON_HEADERS,
  PAGE_FILES_PREFIX,
  pageFileHeaders,
  pageFilePathSchema,
  pageHostOf,
  pageLimits,
  pagePathSchema,
  pageRequestPath,
  pageResponseHeaders,
  slugOfPageHost,
} from '@repo/domain'

import type { PagesServerConfig } from '../config/config.tokens.ts'
import {
  compressible,
  negotiateEncoding,
  noneMatchHits,
  PageBodies,
  taggedBases,
  variantTag,
  type BodyEncoding,
  type BodyEntry,
} from './page-bodies.ts'
import { pageCookieOpens, pageSetCookie } from './page-cookie.ts'
import {
  deletedPage,
  failedPage,
  notFoundPage,
  passwordFormPage,
  takenDownPage,
  writingPage,
  type PasswordFormState,
} from './page-replies.ts'

/**
 * The server of published pages (docs/plan/69-pages.md, Ст4, Ст9, Ст10, Ст13, Ст25): its own
 * listener of the preview app, answering `<slug>.<PAGES_BASE_DOMAIN>` alone, from the database
 * alone. A host is a site of pages (docs/plan/73-pages-sites.md, Дер11, §5.2): `GET`/`HEAD` of a
 * canonical path — the current version of the page there under its policy; `POST` — the password
 * form of the site; `/robots.txt` — nothing to index; everything else — 308 to the canon, 404, 410
 * or 405. The content of a page is never
 * logged, nor the slug of one: a line says the status and the kind of the answer.
 */

export type { PagesServerConfig }

/** The health of the role on the pages listener: any host that is not a page's. */
export const PAGES_HEALTH_PATH = '/__raditi/health'

export interface PagesStore {
  /**
   * The site of a host and what it holds at a canonical path (docs/plan/73-pages-sites.md, Дер16),
   * without the bytes of the page (plan 96, P34).
   */
  served(slug: string, path: string): Promise<ServedSiteMeta | null>
  /** The site of a host alone, for its shared files. */
  site(slug: string): Promise<ServedTree | null>
  /** The bytes of the current version of a page and its number; null — none. */
  content(pageId: string): Promise<{ version: number; bytes: Uint8Array } | null>
  /**
   * A shared file of a site (docs/plan/73-pages-sites.md, Дер34); null — none at that path. Its
   * bytes are null when its sha256 is one of `known`.
   */
  file(
    treeId: string,
    path: string,
    known: readonly string[],
  ): Promise<{ type: string; bytes: Uint8Array | null; sha256: string; sizeBytes: number } | null>
  /** One attempt under `key` within its window; false — over the limit. */
  admit(key: string, limit: number, windowMs: number, now: number): Promise<boolean>
  verify(password: string, hash: string): Promise<boolean>
}

export interface PagesServerDependencies {
  config: PagesServerConfig
  store: PagesStore
  clock?: () => number
  logger?: { warn(message: string): void }
  /** The bodies kept between requests; a new cache of `BODY_CACHE_BYTES` by default. */
  bodies?: PageBodies
}

/** The coding, the ETag and the headers of one representation (plan 96, P34). */
interface Representation {
  encoding: BodyEncoding
  etag: string
  headers: Record<string, string>
}

/**
 * How a body of this type and size goes to this viewer: compressed by `Accept-Encoding` when it
 * compresses — then `Vary`, whichever coding this viewer took —, under the ETag of that coding.
 */
function representationOf(
  request: IncomingMessage,
  type: string,
  size: number,
  base: string,
): Representation {
  if (!compressible(type, size))
    return { encoding: 'identity', etag: variantTag(base, 'identity'), headers: {} }
  const encoding = negotiateEncoding(request.headers['accept-encoding'])
  return {
    encoding,
    etag: variantTag(base, encoding),
    headers: {
      Vary: 'Accept-Encoding',
      ...(encoding === 'identity' ? {} : { 'Content-Encoding': encoding }),
    },
  }
}

type Kind = 'html' | 'reading' | 'platform'

function send(
  response: ServerResponse,
  head: boolean,
  status: number,
  kind: Kind,
  body: string | Uint8Array,
  extra: Record<string, string> = {},
): void {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : body
  response.writeHead(status, {
    ...pageResponseHeaders(kind),
    'Content-Length': String(bytes.byteLength),
    ...extra,
  })
  response.end(head ? undefined : bytes)
}

function sendText(
  response: ServerResponse,
  head: boolean,
  status: number,
  text: string,
  extra: Record<string, string> = {},
): void {
  const bytes = Buffer.from(text, 'utf8')
  response.writeHead(status, {
    ...PAGE_COMMON_HEADERS,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Content-Length': String(bytes.byteLength),
    ...extra,
  })
  response.end(head ? undefined : bytes)
}

/**
 * The address the counters key a viewer by. `X-Forwarded-For` is believed only from a private or
 * loopback neighbour — Traefik on the private network, which appends the client as the last hop
 * (as web reads it); from any other socket the socket itself. Kept only as a MAC inside the
 * counter's key, never as is.
 */
export function viewerOf(request: Pick<IncomingMessage, 'headers' | 'socket'>): string {
  const socket = (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '')
  if (!isPrivateAddress(socket) && !isLoopbackAddress(socket)) return socket
  const forwarded = String(request.headers['x-forwarded-for'] ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
  return forwarded.at(-1) ?? socket
}

/** The body of the password form, at most `pageLimits.passwordFormBytes`; null — too large. */
async function readForm(request: IncomingMessage): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength
    if (size > pageLimits.passwordFormBytes) return null
    chunks.push(chunk as Buffer)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

export class PagesServer {
  readonly #deps: PagesServerDependencies
  readonly #server: Server
  readonly #clock: () => number
  readonly #bodies: PageBodies

  constructor(deps: PagesServerDependencies) {
    this.#deps = deps
    this.#clock = deps.clock ?? Date.now
    this.#bodies = deps.bodies ?? new PageBodies()
    this.#server = createServer(
      { requestTimeout: 15_000, headersTimeout: 10_000 },
      (request, response) => {
        this.#handle(request, response).catch((error: unknown) => {
          this.#deps.logger?.warn(
            `pages_failed reason=${error instanceof Error ? error.name : 'unknown'}`,
          )
          if (!response.headersSent)
            send(response, false, 500, 'platform', failedPage(this.#deps.config.abuseEmail))
          else response.destroy()
        })
      },
    )
  }

  async listen(port: number, host: string | undefined): Promise<AddressInfo> {
    this.#server.listen(port, host)
    await once(this.#server, 'listening')
    return this.#server.address() as AddressInfo
  }

  /** Where it listens; null before listen() and after close(). */
  address(): AddressInfo | null {
    return this.#server.listening ? (this.#server.address() as AddressInfo) : null
  }

  /** Nest's shutdown hook: the database pool closes after this listener. */
  async onApplicationShutdown(): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    if (!this.#server.listening) return
    this.#server.closeIdleConnections()
    await new Promise<void>((resolve) => this.#server.close(() => resolve()))
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const { config, store } = this.#deps
    const method = request.method ?? 'GET'
    const head = method === 'HEAD'
    const slug = slugOfPageHost(request.headers.host, {
      baseDomain: config.baseDomain,
      ...(config.publicPort === undefined ? {} : { port: config.publicPort }),
    })
    // Not a page host: no stub, nothing that looks like the platform (Ст3) — but the health of
    // the role, which a compose healthcheck asks on 127.0.0.1 (no page is ever there).
    if (slug === null) {
      if (method === 'GET' && (request.url ?? '').split('?')[0] === PAGES_HEALTH_PATH)
        return sendText(response, false, 200, 'ok')
      return sendText(response, head, 404, 'Not found')
    }
    if (!(PAGE_METHODS as readonly string[]).includes(method))
      return sendText(response, false, 405, 'Method not allowed', {
        Allow: PAGE_METHODS.join(', '),
      })
    const raw = (request.url ?? '/').split('?')[0] ?? '/'
    if (raw === '/robots.txt' && method !== 'POST')
      return sendText(response, head, 200, PAGE_ROBOTS_TXT)
    // A shared file of the site (Дер34): what its pages load, by its own path.
    if (raw.startsWith(PAGE_FILES_PREFIX)) return this.#file(request, response, slug, raw, method)
    // The path is read by the schema alone: nothing decoded, nothing of the request sent back
    // as it came (docs/plan/73-pages-sites.md, Дер15).
    const read = pageRequestPath(raw)
    const site = await store.served(slug, read.kind === 'page' ? read.path : '/')
    if (site === null) return send(response, head, 404, 'platform', notFoundPage(config.abuseEmail))
    // The site first: taken down, or in the trash — every path is gone (Дер2, Дер18).
    if (site.gone === 'taken_down')
      return send(response, head, 410, 'platform', takenDownPage(config.abuseEmail))
    if (site.gone === 'deleted')
      return send(response, head, 410, 'platform', deletedPage(config.abuseEmail))

    // The site has its own name and was asked by another label — its slug or a name it had —:
    // on to its name at the same canonical path (docs/plan/73-pages-sites.md, Дер32). The address
    // is relative to the scheme, so the viewer stays on theirs; nothing of the request goes in.
    if (site.host !== null) {
      const port = config.publicPort === undefined ? '' : `:${config.publicPort}`
      const path = read.kind === 'none' ? '/' : read.path
      return this.#moved(
        response,
        head,
        `//${pageHostOf(site.host, config.baseDomain)}${port}${pagePathSchema.parse(path)}`,
        false,
      )
    }

    // The password of the site before any page of it: without the cookie every path — one that
    // is not there too — answers the form, so the site tells nothing of its paths (Дер16, Дер17).
    // The form posts to the canonical path it was asked for, or to the home page.
    const back = read.kind === 'none' ? '/' : read.path
    if (site.passwordHash !== null) {
      const now = this.#clock()
      const guarded = { ...site, passwordHash: site.passwordHash }
      if (method === 'POST') return this.#password(request, response, guarded, back, now)
      if (
        !pageCookieOpens(
          config.cookieSecret,
          { id: site.treeId, passwordEpoch: site.passwordEpoch },
          request.headers.cookie,
          now,
        )
      )
        return this.#form(response, head, 'ask', back)
    }
    // A site without a password takes no form — said only where a page is, not to tell one is.
    const refused = () =>
      sendText(response, false, 405, 'Method not allowed', { Allow: 'GET, HEAD' })

    if (read.kind === 'redirect') return this.#moved(response, head, read.path)
    if (read.kind === 'none')
      return send(response, head, 404, 'platform', notFoundPage(config.abuseEmail))
    const page = site.page
    if (page === null || page.deleted) {
      // A former path sends on to where its page is now (Дер19); none — the page is gone.
      if (site.redirect !== null) return this.#moved(response, head, site.redirect)
      if (page !== null)
        return send(response, head, 410, 'platform', deletedPage(config.abuseEmail))
      return send(response, head, 404, 'platform', notFoundPage(config.abuseEmail))
    }
    if (page.state === 'taken_down')
      return send(response, head, 410, 'platform', takenDownPage(config.abuseEmail))
    if (page.state === 'pending' && page.kind !== 'doc')
      return send(response, head, 404, 'platform', notFoundPage(config.abuseEmail))
    if (method === 'POST') return refused()
    // A document published before its first version is done (Ст25).
    if (page.content === null)
      return send(response, head, 200, 'platform', writingPage(config.abuseEmail))
    // The version is the page's identity at its path: the same one is not sent twice (Дер22) —
    // and its bytes are not read for a 304 (plan 96, P34).
    const kind = page.kind === 'html' ? 'html' : 'reading'
    const type = pageResponseHeaders(kind)['Content-Type']!
    const known = representationOf(
      request,
      type,
      page.content.sizeBytes,
      `${page.id}.${page.content.version}`,
    )
    if (noneMatchHits(request.headers['if-none-match'], known.etag)) {
      response.writeHead(304, { ...pageResponseHeaders(kind), ...known.headers, ETag: known.etag })
      response.end()
      return
    }
    const key = `page:${page.id}`
    let entry = this.#bodies.get(key, String(page.content.version))
    let current = known
    if (!entry) {
      const read = await store.content(page.id)
      if (read === null)
        return send(response, head, 404, 'platform', notFoundPage(config.abuseEmail))
      entry = this.#bodies.put(key, String(read.version), read.bytes)
      // A version published since the page was read goes under its own number.
      if (read.version !== page.content.version)
        current = representationOf(
          request,
          type,
          read.bytes.byteLength,
          `${page.id}.${read.version}`,
        )
    }
    return send(response, head, 200, kind, await this.#bodies.body(entry, current.encoding), {
      ...current.headers,
      ETag: current.etag,
    })
  }

  /**
   * A shared file (Дер34): GET and HEAD only, its path by the schema alone. A site taken down or
   * in the trash answers 410, one with a password 404 without its cookie — a file is no page and
   * has no form. Its own headers; 304 for the bytes the viewer has.
   */
  async #file(
    request: IncomingMessage,
    response: ServerResponse,
    slug: string,
    raw: string,
    method: string,
  ): Promise<void> {
    const { config, store } = this.#deps
    const head = method === 'HEAD'
    if (method === 'POST')
      return sendText(response, false, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
    if (!pageFilePathSchema.safeParse(raw).success)
      return sendText(response, head, 404, 'Not found')
    const site = await store.site(slug)
    if (site === null) return sendText(response, head, 404, 'Not found')
    if (site.gone !== null) return sendText(response, head, 410, 'Gone')
    if (site.host !== null) {
      const port = config.publicPort === undefined ? '' : `:${config.publicPort}`
      return this.#moved(
        response,
        head,
        `//${pageHostOf(site.host, config.baseDomain)}${port}${raw}`,
        false,
      )
    }
    if (
      site.passwordHash !== null &&
      !pageCookieOpens(
        config.cookieSecret,
        { id: site.treeId, passwordEpoch: site.passwordEpoch },
        request.headers.cookie,
        this.#clock(),
      )
    )
      return sendText(response, head, 404, 'Not found')
    // The sha256 first (plan 96, P34): the bytes of a version the viewer has, or the cache
    // keeps, are not read.
    const key = `file:${site.treeId}${raw}`
    const ifNoneMatch = request.headers['if-none-match']
    const cached = this.#bodies.tagOf(key)
    const known = [...taggedBases(ifNoneMatch), ...(cached === undefined ? [] : [cached])]
    let file = await store.file(site.treeId, raw, known)
    if (file === null) return sendText(response, head, 404, 'Not found')
    let shown = representationOf(request, file.type, file.sizeBytes, file.sha256)
    if (noneMatchHits(ifNoneMatch, shown.etag)) {
      response.writeHead(304, { ...pageFileHeaders(file.type), ...shown.headers, ETag: shown.etag })
      response.end()
      return
    }
    let entry: BodyEntry | undefined =
      file.bytes === null
        ? this.#bodies.get(key, file.sha256)
        : this.#bodies.put(key, file.sha256, file.bytes)
    if (!entry) {
      // Left without its bytes and not in the cache (another coding was asked, or the cache let
      // it go meanwhile): once more, with the bytes.
      file = await store.file(site.treeId, raw, [])
      if (file?.bytes == null) return sendText(response, head, 404, 'Not found')
      entry = this.#bodies.put(key, file.sha256, file.bytes)
      shown = representationOf(request, file.type, file.sizeBytes, file.sha256)
    }
    const body = await this.#bodies.body(entry, shown.encoding)
    response.writeHead(200, {
      ...pageFileHeaders(file.type),
      ...shown.headers,
      ETag: shown.etag,
      'Content-Length': String(body.byteLength),
    })
    response.end(head ? undefined : body)
  }

  /**
   * 308 to a canonical path the schema took — or, `checked` false, to an address made of checked
   * parts —; the request's own text never goes into Location.
   */
  #moved(response: ServerResponse, head: boolean, path: string, checked = true): void {
    const location = checked ? pagePathSchema.parse(path) : path
    response.writeHead(308, {
      ...PAGE_COMMON_HEADERS,
      Location: location,
      'Cache-Control': 'no-store',
      'Content-Length': '0',
    })
    response.end()
  }

  #form(
    response: ServerResponse,
    head: boolean,
    state: PasswordFormState,
    path: string,
    status = 200,
    extra: Record<string, string> = {},
  ): void {
    send(
      response,
      head,
      status,
      'platform',
      passwordFormPage(state, pagePathSchema.parse(path), this.#deps.config.abuseEmail),
      extra,
    )
  }

  async #password(
    request: IncomingMessage,
    response: ServerResponse,
    site: ServedTree & { passwordHash: string },
    path: string,
    now: number,
  ): Promise<void> {
    const { config, store } = this.#deps
    const type = String(request.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase()
    if (type !== 'application/x-www-form-urlencoded')
      return this.#form(response, false, 'ask', path, 415)
    const form = await readForm(request)
    if (form === null) return this.#form(response, false, 'too_long', path, 413)
    const viewer = createHmac('sha256', config.cookieSecret)
      .update(`raditi-page-viewer|${viewerOf(request)}`)
      .digest('hex')
    // An address over its own limit spends nothing of the site's: one address cannot shut the
    // site for every viewer. The counters are the site's (Дер17): its id is the former page's.
    const perViewer = await store.admit(
      `page-password:${site.treeId}:${viewer}`,
      pageLimits.passwordAttemptsPerAddress,
      pageLimits.passwordAttemptsPerAddressWindowSeconds * 1000,
      now,
    )
    if (!perViewer)
      return this.#form(response, false, 'too_many', path, 429, {
        'Retry-After': String(pageLimits.passwordAttemptsPerAddressWindowSeconds),
      })
    const perSite = await store.admit(
      `page-password:${site.treeId}`,
      pageLimits.passwordAttemptsPerPage,
      pageLimits.passwordAttemptsPerPageWindowSeconds * 1000,
      now,
    )
    if (!perSite)
      return this.#form(response, false, 'too_many', path, 429, {
        'Retry-After': String(pageLimits.passwordAttemptsPerPageWindowSeconds),
      })
    const password = form.get('password') ?? ''
    if (!(await store.verify(password, site.passwordHash)))
      return this.#form(response, false, 'wrong', path)
    response.writeHead(303, {
      ...PAGE_COMMON_HEADERS,
      Location: pagePathSchema.parse(path),
      'Cache-Control': 'no-store',
      'Content-Length': '0',
      'Set-Cookie': pageSetCookie(
        config.cookieSecret,
        { id: site.treeId, passwordEpoch: site.passwordEpoch },
        now,
        pageLimits.passwordCookieSeconds,
      ),
    })
    response.end()
  }
}
