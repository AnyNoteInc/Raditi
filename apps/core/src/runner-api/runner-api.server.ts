import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

import { Logger, type OnApplicationShutdown } from '@nestjs/common'
import {
  isDomainError,
  RUNNER_API_PREFIX,
  runnerHeaders,
  runnerLimits,
  runnerPollRequestSchema,
  runnerReconcileRequestSchema,
  runnerReportSchema,
  snapshotLimits,
} from '@repo/domain'
import { throttledLogger, type ThrottledLog } from '@repo/observability'
import { ZodError } from 'zod'

import { RunnerApiError } from './runner-api-error.ts'
import type { CandidatePart, RunnerBinaryHeaders, RunnerHub } from './runner-hub.ts'
import type { RunnerAuthenticator } from './runner-auth.ts'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ASSIGNMENT = new RegExp(
  `^${RUNNER_API_PREFIX}/assignments/(${UUID})/(bundle|keys/(restore|seal)|candidate/(patch|untracked)|inbox/(0|[1-9][0-9]?))$`,
)
const candidateLimits: Record<CandidatePart, number> = {
  patch: snapshotLimits.patchBytes,
  untracked: snapshotLimits.archiveBytes,
}
/** Headers of a response never let a proxy or client keep keys, bundles or commands. */
const NO_STORE = { 'cache-control': 'no-store' }

class TooLarge extends Error {}

/**
 * A body of the size core announced — the base bundle, a file of the client: one that differs
 * from it is cut off, never completed.
 */
async function sendSized(
  response: ServerResponse,
  body: { sizeBytes: number; read(): AsyncIterable<Uint8Array> },
): Promise<void> {
  response.writeHead(200, {
    ...NO_STORE,
    'content-type': 'application/octet-stream',
    'content-length': String(body.sizeBytes),
  })
  let sent = 0
  for await (const chunk of body.read()) {
    sent += chunk.byteLength
    if (sent > body.sizeBytes) break
    if (!response.write(chunk))
      await Promise.race([once(response, 'drain'), once(response, 'close')])
    if (response.destroyed) return
  }
  if (sent !== body.sizeBytes) response.destroy()
  else response.end()
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers['content-length'] ?? Number.NaN)
  if (declared > maxBytes) throw new TooLarge()
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request as AsyncIterable<Buffer>) {
    total += chunk.byteLength
    if (total > maxBytes) throw new TooLarge()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, total)
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(;|$)/.test(request.headers['content-type'] ?? ''))
    throw RunnerApiError.of('BAD_REQUEST')
  const body = await readBody(request, runnerLimits.bodyBytes)
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
  } catch {
    throw RunnerApiError.of('BAD_REQUEST')
  }
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

function binaryHeaders(request: IncomingMessage): RunnerBinaryHeaders {
  return {
    session: request.headers[runnerHeaders.session],
    epoch: request.headers[runnerHeaders.epoch],
    command: request.headers[runnerHeaders.command],
  }
}

/**
 * The runner API of core on its own port, RUNNER_API_PORT (spec §8, §19): only runner VMs on
 * the private network reach it. Plain node:http, so bodies, long polls and binary answers stay
 * under explicit limits. Presigned URLs travel only inside command bodies and data keys only in
 * key answers; neither is ever logged, and neither are request URLs.
 */
export class RunnerApiServer implements OnApplicationShutdown {
  #server: Server | undefined
  readonly #log: ThrottledLog

  constructor(
    private readonly hub: RunnerHub,
    private readonly auth: RunnerAuthenticator,
    logger: { warn(message: string): void } = new Logger('RunnerApi'),
  ) {
    this.#log = throttledLogger((line) => logger.warn(line))
  }

  readonly handle = (request: IncomingMessage, response: ServerResponse): void => {
    void this.#handle(request, response)
  }

  async listen(port: number, host?: string): Promise<AddressInfo> {
    const server = createServer(this.handle)
    // Long polls hold up to 25 s; a request must still arrive in full within a minute.
    server.requestTimeout = 60_000
    server.headersTimeout = 30_000
    this.#server = server
    server.listen(port, host)
    await once(server, 'listening')
    return server.address() as AddressInfo
  }

  async onApplicationShutdown(): Promise<void> {
    await this.close()
  }

  /** Waiting polls answer empty; the runners retry against the next core. */
  async close(): Promise<void> {
    this.hub.close()
    const server = this.#server
    this.#server = undefined
    if (!server?.listening) return
    const closed = once(server, 'close')
    server.close()
    server.closeIdleConnections()
    await closed
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const runnerId = this.auth.authenticate(
        request.headers.authorization,
        request.socket.remoteAddress,
      )
      if (!runnerId) throw RunnerApiError.of('UNAUTHORIZED')
      await this.#route(runnerId, request, response)
    } catch (error) {
      if (response.headersSent) {
        response.destroy()
        return
      }
      if (error instanceof RunnerApiError) sendJson(response, error.status, error.body)
      else if (error instanceof TooLarge) {
        // The client reads the answer once it sent its body; the connection ends with it.
        request.resume()
        if (!request.complete)
          await Promise.race([once(request, 'end'), once(request, 'close')]).catch(() => {})
        response.setHeader('connection', 'close')
        sendJson(response, 413, { error: 'TOO_LARGE' })
      } else if (error instanceof ZodError) sendJson(response, 400, { error: 'BAD_REQUEST' })
      else {
        // The route kind and an error code only: URLs, bodies and messages stay out of logs.
        this.#log(
          'runner API request',
          new Error(isDomainError(error) ? error.code : error instanceof Error ? error.name : '?'),
        )
        sendJson(response, 500, { error: 'INTERNAL' })
      }
    }
  }

  async #route(
    runnerId: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const path = request.url ?? ''
    const method = request.method
    if (method === 'POST' && path === `${RUNNER_API_PREFIX}/poll`) {
      const poll = runnerPollRequestSchema.parse(await readJson(request))
      const aborted = new AbortController()
      response.once('close', () => aborted.abort())
      const answer = await this.hub.poll(runnerId, poll, aborted.signal)
      // Closed already: its `close` fired before the listener below, and nothing reaches the runner.
      if (aborted.signal.aborted) {
        if (answer.commands.length > 0)
          this.hub.requeue(runnerId, poll.runnerSession, answer.commands)
        return
      }
      let delivered = false
      response.once('finish', () => {
        delivered = true
      })
      response.once('close', () => {
        if (!delivered && answer.commands.length > 0)
          this.hub.requeue(runnerId, poll.runnerSession, answer.commands)
      })
      sendJson(response, 200, answer)
      return
    }
    if (method === 'POST' && path === `${RUNNER_API_PREFIX}/reports`) {
      await this.hub.report(runnerId, runnerReportSchema.parse(await readJson(request)))
      sendJson(response, 200, { ok: true })
      return
    }
    if (method === 'POST' && path === `${RUNNER_API_PREFIX}/reconcile`) {
      const reconcile = runnerReconcileRequestSchema.parse(await readJson(request))
      sendJson(response, 200, await this.hub.reconcile(runnerId, reconcile))
      return
    }
    const match = ASSIGNMENT.exec(path)
    if (!match) throw RunnerApiError.of('NOT_FOUND')
    const [, assignmentId, resource, purpose, part, place] = match as unknown as [
      string,
      string,
      string,
      'restore' | 'seal' | undefined,
      CandidatePart | undefined,
      string | undefined,
    ]
    if (method === 'GET' && resource === 'bundle') {
      await sendSized(
        response,
        await this.hub.bundle(runnerId, assignmentId, binaryHeaders(request)),
      )
      return
    }
    if (method === 'GET' && place !== undefined) {
      const file = await this.hub.inboxFile(
        runnerId,
        assignmentId,
        Number(place),
        binaryHeaders(request),
      )
      await sendSized(response, file)
      return
    }
    if (method === 'GET' && purpose) {
      const key = await this.hub.key(runnerId, assignmentId, purpose, binaryHeaders(request))
      const zero = () => key.fill(0)
      response.once('close', zero)
      response.writeHead(200, {
        ...NO_STORE,
        'content-type': 'application/octet-stream',
        'content-length': String(key.byteLength),
      })
      // Zeroed once the socket took it; the buffer is not copied on the way.
      response.end(key, zero)
      return
    }
    if (method === 'PUT' && part) {
      const store = await this.hub.candidate(runnerId, assignmentId, part, binaryHeaders(request))
      store(await readBody(request, candidateLimits[part]))
      sendJson(response, 200, { ok: true })
      return
    }
    throw RunnerApiError.of('NOT_FOUND')
  }
}
