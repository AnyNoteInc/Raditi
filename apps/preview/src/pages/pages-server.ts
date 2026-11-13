import { createHmac } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import type { ServedPage } from '@repo/db'
import { isLoopbackAddress, isPrivateAddress } from '@repo/ip-address'
import {
  PAGE_METHODS,
  PAGE_ROBOTS_TXT,
  PAGE_COMMON_HEADERS,
  pageLimits,
  pageResponseHeaders,
  slugOfPageHost,
} from '@repo/domain'

import type { PagesServerConfig } from '../config/config.tokens.ts'
import { pageCookieOpens, pageSetCookie } from './page-cookie.ts'
import {
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
 * alone. `GET`/`HEAD /` — the current version under its policy; `POST /` — the password form;
 * `/robots.txt` — nothing to index; everything else — 404 or 405. The content of a page is never
 * logged, nor the slug of one: a line says the status and the kind of the answer.
 */

export type { PagesServerConfig }

export interface PagesStore {
  served(slug: string): Promise<ServedPage | null>
  /** One attempt under `key` within its window; false — over the limit. */
  admit(key: string, limit: number, windowMs: number, now: number): Promise<boolean>
  verify(password: string, hash: string): Promise<boolean>
}

export interface PagesServerDependencies {
  config: PagesServerConfig
  store: PagesStore
  clock?: () => number
  logger?: { warn(message: string): void }
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
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body)
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

  constructor(deps: PagesServerDependencies) {
    this.#deps = deps
    this.#clock = deps.clock ?? Date.now
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
    // Not a page host: no stub, nothing that looks like the platform (Ст3).
    if (slug === null) return sendText(response, head, 404, 'Not found')
    if (!(PAGE_METHODS as readonly string[]).includes(method))
      return sendText(response, false, 405, 'Method not allowed', {
        Allow: PAGE_METHODS.join(', '),
      })
    const path = (request.url ?? '/').split('?')[0]
    if (path === '/robots.txt' && method !== 'POST')
      return sendText(response, head, 200, PAGE_ROBOTS_TXT)
    if (path !== '/') return send(response, head, 404, 'platform', notFoundPage(config.abuseEmail))

    const page = await store.served(slug)
    if (page === null || (page.state === 'pending' && page.kind !== 'doc'))
      return send(response, head, 404, 'platform', notFoundPage(config.abuseEmail))
    if (page.state === 'taken_down')
      return send(response, head, 410, 'platform', takenDownPage(config.abuseEmail))

    if (page.passwordHash !== null) {
      const now = this.#clock()
      if (method === 'POST')
        return this.#password(request, response, { ...page, passwordHash: page.passwordHash }, now)
      if (
        !pageCookieOpens(
          config.cookieSecret,
          { id: page.id, passwordEpoch: page.passwordEpoch },
          request.headers.cookie,
          now,
        )
      )
        return this.#form(response, head, 'ask')
    } else if (method === 'POST') {
      return sendText(response, false, 405, 'Method not allowed', { Allow: 'GET, HEAD' })
    }

    // A document published before its first version is done (Ст25).
    if (page.content === null)
      return send(response, head, 200, 'platform', writingPage(config.abuseEmail))
    return send(response, head, 200, page.kind === 'html' ? 'html' : 'reading', page.content.bytes)
  }

  #form(
    response: ServerResponse,
    head: boolean,
    state: PasswordFormState,
    status = 200,
    extra: Record<string, string> = {},
  ): void {
    send(
      response,
      head,
      status,
      'platform',
      passwordFormPage(state, this.#deps.config.abuseEmail),
      extra,
    )
  }

  async #password(
    request: IncomingMessage,
    response: ServerResponse,
    page: ServedPage & { passwordHash: string },
    now: number,
  ): Promise<void> {
    const { config, store } = this.#deps
    const type = String(request.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase()
    if (type !== 'application/x-www-form-urlencoded') return this.#form(response, false, 'ask', 415)
    const form = await readForm(request)
    if (form === null) return this.#form(response, false, 'too_long', 413)
    const viewer = createHmac('sha256', config.cookieSecret)
      .update(`raditi-page-viewer|${viewerOf(request)}`)
      .digest('hex')
    // An address over its own limit spends nothing of the page's: one address cannot shut the
    // page for every viewer.
    const perViewer = await store.admit(
      `page-password:${page.id}:${viewer}`,
      pageLimits.passwordAttemptsPerAddress,
      pageLimits.passwordAttemptsPerAddressWindowSeconds * 1000,
      now,
    )
    if (!perViewer)
      return this.#form(response, false, 'too_many', 429, {
        'Retry-After': String(pageLimits.passwordAttemptsPerAddressWindowSeconds),
      })
    const perPage = await store.admit(
      `page-password:${page.id}`,
      pageLimits.passwordAttemptsPerPage,
      pageLimits.passwordAttemptsPerPageWindowSeconds * 1000,
      now,
    )
    if (!perPage)
      return this.#form(response, false, 'too_many', 429, {
        'Retry-After': String(pageLimits.passwordAttemptsPerPageWindowSeconds),
      })
    const password = form.get('password') ?? ''
    if (!(await store.verify(password, page.passwordHash)))
      return this.#form(response, false, 'wrong')
    response.writeHead(303, {
      ...PAGE_COMMON_HEADERS,
      Location: '/',
      'Cache-Control': 'no-store',
      'Content-Length': '0',
      'Set-Cookie': pageSetCookie(
        config.cookieSecret,
        { id: page.id, passwordEpoch: page.passwordEpoch },
        now,
        pageLimits.passwordCookieSeconds,
      ),
    })
    response.end()
  }
}
