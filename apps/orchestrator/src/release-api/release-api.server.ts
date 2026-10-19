import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Logger, type OnApplicationShutdown } from '@nestjs/common'
import {
  isDomainError,
  RELEASE_API_HEALTH_PATH,
  RELEASE_API_PREFIX,
  releaseApiLimits,
} from '@repo/domain'
import { throttledLogger } from '@repo/observability'

import type { ReleaseApi } from './release-api.service.ts'

/** Headers of every answer: nothing a proxy or a job may keep. */
const NO_STORE = { 'cache-control': 'no-store' }
const ROUTE = new RegExp(
  `^${RELEASE_API_PREFIX}/([0-9a-fA-F-]{36})/(manifest|access|steps|backup|values/(\\d{1,4}))$`,
)
const METHODS = {
  manifest: 'GET',
  access: 'POST',
  steps: 'POST',
  backup: 'POST',
  values: 'GET',
} as const

/** HTTP status of a refusal by its code; the body names the code only. */
const statusOf: Readonly<Record<string, number>> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  LEASE_LOST: 409,
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const json = Buffer.from(JSON.stringify(body))
  response.writeHead(status, {
    ...NO_STORE,
    'content-type': 'application/json',
    'content-length': String(json.byteLength),
  })
  response.end(json)
}

class BodyTooLarge extends Error {}
class BodyInvalid extends Error {}

/** The JSON body of a call, at most `releaseApiLimits.bodyBytes`; `{}` when there is none. */
async function readBody(request: IncomingMessage): Promise<unknown> {
  const declared = Number(request.headers['content-length'] ?? 0)
  if (declared > releaseApiLimits.bodyBytes) throw new BodyTooLarge()
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.byteLength
    if (bytes > releaseApiLimits.bodyBytes) throw new BodyTooLarge()
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    throw new BodyInvalid()
  }
}

/**
 * The release API of core on its own port, RELEASE_API_PORT (docs/plan/53-chat-preview-release.md,
 * Р32): only the containers of deploy jobs reach it. Plain node:http like the runner API; the
 * calls of deploy-manifest.ts, each with the Bearer token of its deploy attempt. Answers carry
 * no cache, a refusal names its code only — never a path, a host or a message.
 */
export class ReleaseApiServer implements OnApplicationShutdown {
  #server: Server | undefined
  readonly #logger = new Logger('ReleaseApi')
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  /** null — releases are off in this core: only the health answers. */
  constructor(private readonly api: ReleaseApi | null) {}

  readonly handle = (request: IncomingMessage, response: ServerResponse): void => {
    // The connection closes after the answer: a job makes one call at a time.
    response.setHeader('connection', 'close')
    void this.#route(request, response).catch((error: unknown) => {
      this.#warn('release API call failed', error)
      if (!response.headersSent) sendJson(response, 503, { error: 'UNAVAILABLE' })
      else response.destroy()
    })
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '').split('?')[0] ?? ''
    if (request.method === 'GET' && path === RELEASE_API_HEALTH_PATH) {
      sendJson(response, 200, { status: 'ok' })
      return
    }
    const match = ROUTE.exec(path)
    const call = match?.[2]?.split('/')[0] as keyof typeof METHODS | undefined
    if (!match || !call || !this.api) {
      sendJson(response, 404, { error: 'NOT_FOUND' })
      return
    }
    if (request.method !== METHODS[call]) {
      sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' })
      return
    }
    const releaseId = match[1]!.toLowerCase()
    const authorization = request.headers.authorization
    let body: unknown = {}
    try {
      if (request.method === 'POST') body = await readBody(request)
    } catch (error) {
      if (error instanceof BodyTooLarge) sendJson(response, 413, { error: 'BODY_TOO_LARGE' })
      else if (error instanceof BodyInvalid) sendJson(response, 400, { error: 'BAD_REQUEST' })
      else throw error
      return
    }
    try {
      switch (call) {
        case 'manifest':
          sendJson(response, 200, await this.api.manifest(releaseId, authorization))
          return
        case 'access':
          sendJson(response, 200, await this.api.access(releaseId, authorization, body))
          return
        case 'steps': {
          const answer = await this.api.step(releaseId, authorization, body)
          sendJson(response, answer.status, answer.answer)
          return
        }
        case 'backup':
          sendJson(response, 200, await this.api.backup(releaseId, authorization, body))
          return
        case 'values': {
          const sealed = await this.api.value(releaseId, authorization, match[3]!)
          response.writeHead(200, {
            ...NO_STORE,
            'content-type': 'application/octet-stream',
            'content-length': String(sealed.byteLength),
          })
          response.end(sealed)
          return
        }
      }
    } catch (error) {
      const status = isDomainError(error) ? statusOf[error.code] : undefined
      if (!isDomainError(error) || status === undefined) throw error
      sendJson(response, status, { error: error.code })
    }
  }

  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer(this.handle)
    server.requestTimeout = 60_000
    server.headersTimeout = 30_000
    this.#server = server
    server.listen(port, host)
    await once(server, 'listening')
    return server.address() as AddressInfo
  }

  /** Where it listens; null before listen() and after close(). */
  address(): AddressInfo | null {
    const address = this.#server?.address()
    return address && typeof address === 'object' ? address : null
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close()
  }

  async close(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (!server?.listening) return
    const closed = once(server, 'close')
    server.close()
    server.closeIdleConnections()
    await closed
  }
}
