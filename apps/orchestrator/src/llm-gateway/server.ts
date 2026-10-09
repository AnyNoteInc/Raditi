import { Buffer } from 'node:buffer'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { BlockList, isIP, type AddressInfo } from 'node:net'
import { setTimeout as delay } from 'node:timers/promises'

import {
  callSignalSchema,
  isDomainError,
  llmJsonLimits,
  parseLlmJson,
  refusalForSignal,
  withTimeout,
  type CallSignal,
  type GatewayRefusal,
  type LlmBackend,
  type LlmRoute,
  type SubscriptionCredential,
} from '@repo/domain'
import { createSseDecoder, emptyMeterResult, type SseEvent } from '@repo/llm-backends'
import { Counter, Gauge, Registry } from '@prometheus-io/client'
import { bearerTokenMatches, createMetricsRegistry } from '@repo/observability'
import { z } from 'zod'

import type { LlmConfig } from '../config/llm-config.ts'
import { LLM_KEY_PATTERN, turnKeyHash } from '../llm/turn-key.ts'
import type { CredentialSource } from './credentials.ts'
import type { StreamingEgress, StreamingEgressResponse } from './egress.ts'
import {
  EgressNotDelivered,
  GatewayRecordRejected,
  type GatewayCall,
  type GatewayFinish,
  type GatewayKey,
  type GatewayStore,
} from './types.ts'

const limits = Object.freeze({
  requests: 64,
  requestsPerSource: 16,
  requestMs: 600_000,
  stallMs: 60_000,
  // A provider or channel silent this long has stalled. The pinned Codex CLI gives a silent
  // stream the same five minutes, so a stream the CLI would still wait for is never cut.
  upstreamIdleMs: 300_000,
  accountWaitMs: 20_000,
  persistenceMs: 600_000,
  shutdownMs: 30_000,
  responseBytes: 64 * 1024 * 1024,
  errorBytes: 64 * 1024,
  refusalMs: 5_000,
  // Retry-After of a platform-side failure: long enough for the CLI's few retries to outlast
  // a broken tunnel or a collector pass, and the upper bound of a short-lived refusal.
  platformRetryMs: 30_000,
})
// Provider-neutral names only. The adapter of a route declares the client headers it reads or
// forwards and the response headers that go back to the CLI, and owns the rules for their values.
const requestHeaders = ['authorization', 'content-type', 'accept']
// Of a successful answer. Not `retry-after`: a pause is the gateway's to name, in a refusal it
// builds itself. A CLI obeys the value a provider writes there, be it weeks long.
const responseHeaders = ['content-type']

export interface GatewayLogger {
  log(message: string): void
  warn(message: string): void
}
export interface GatewayLifecycle {
  pause(key: GatewayKey): { reason: GatewayRefusal; retryAfterMs?: number } | null
  refresh(
    call: GatewayCall,
    backend: LlmBackend,
    observedVersion: number,
  ): Promise<SubscriptionCredential | null>
  observe(call: GatewayCall, finish: GatewayFinish): Promise<void>
  /**
   * Probes accounts whose windows are unknown. Admission adds the snapshot it read for its one
   * account: a remembered probe older than that state does not answer it.
   */
  probeAccounts?(
    accountIds: readonly string[],
    unknownWindows?: { limitsSeenAt?: Date | null },
  ): Promise<void>
  /**
   * Refreshes the window snapshot of an account when it has only grown old: at most one probe
   * per account in five minutes. Whatever comes of it, the caller goes on with what is stored.
   */
  refreshAccount?(accountId: string): Promise<void>
}
export interface LlmGatewayOptions {
  config: LlmConfig
  backends: readonly LlmBackend[]
  store: GatewayStore
  credentials: CredentialSource
  egress: StreamingEgress
  logger?: GatewayLogger
  ready?: () => boolean
  health?: () => Promise<boolean>
  metricsToken?: string
  lifecycle?: GatewayLifecycle
}

class Rejected extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code)
  }
}
const eventBytes = (event: SseEvent): Buffer =>
  Buffer.from(
    `event: ${event.event}\n${event.data
      .split('\n')
      .map((line) => `data: ${line}\n`)
      .join('')}\n`,
  )
const sourceAddress = (address: string | undefined): string =>
  (address ?? '').replace(/^::ffff:/, '')

/** The path an adapter named for the field it rejected, whole; null when it named none. */
function rejectedPath(error: unknown): string | null {
  const details = isDomainError(error) ? error.details : null
  const path = details && typeof details === 'object' && 'path' in details ? details.path : null
  return typeof path === 'string' && /^[A-Za-z_][A-Za-z0-9_.[\]-]*$/.test(path) ? path : null
}

/**
 * The path as the sandbox may read it: without a single digit. A CLI may take a number in the
 * body of a refusal for a status worth a retry, so the numbers of the items are taken out of
 * the whole path, before it is cut; a path with a digit anywhere else is not echoed at all.
 * The log keeps the path as the adapter gave it.
 */
function sandboxPath(path: string): string {
  const named = path.replace(/\[\d+\]/g, '[]')
  if (/\d/.test(named)) return 'unknown'
  // Never cut between the brackets a number was taken out of.
  return named.slice(0, llmJsonLimits.errorPath).replace(/\[$/, '')
}

/**
 * What the log may say about a provider's refusal: the kind and the adapter's own code for it,
 * in the allowlisted form of the port and never anything else an adapter returned.
 */
function signalLine(signal: CallSignal | undefined): { signal?: string; code?: string } {
  if (signal === undefined || signal.kind === 'ok') return {}
  const parsed = callSignalSchema.safeParse(signal)
  // An adapter that broke the contract of the port: not a word of what it returned is logged.
  if (!parsed.success) return { signal: 'invalid' }
  const value = parsed.data
  const code = 'code' in value ? value.code : 'reason' in value ? value.reason : undefined
  return { signal: value.kind, ...(code === undefined ? {} : { code }) }
}

function uniqueHeaders(raw: readonly string[], names: readonly string[]): boolean {
  const allowed = new Set(names)
  const seen = new Set<string>()
  for (let index = 0; index < raw.length; index += 2) {
    const name = raw[index]!.toLowerCase()
    if (!allowed.has(name)) continue
    if (seen.has(name)) return false
    seen.add(name)
  }
  return true
}

function clientHeaders(request: IncomingMessage, declared: readonly string[]): Headers {
  const names = [...requestHeaders, ...declared]
  if (!uniqueHeaders(request.rawHeaders, ['host', ...names]))
    throw new Rejected(403, 'raditi_headers')
  const nominated = new Set(
    String(request.headers.connection ?? '')
      .toLowerCase()
      .split(',')
      .map((name) => name.trim()),
  )
  const headers = new Headers()
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index]!.toLowerCase()
    if (!nominated.has(name) && names.includes(name))
      headers.set(name, request.rawHeaders[index + 1]!)
  }
  return headers
}

async function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {})
    signal.throwIfAborted()
  }
  let abort: () => void = () => {}
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error('Gateway operation aborted'))
    signal.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([operation, cancelled])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function readBody(
  request: IncomingMessage,
  signal: AbortSignal,
  maximumBytes = llmJsonLimits.bytes,
): Promise<Buffer> {
  const declared = Number(request.headers['content-length'])
  if (declared > maximumBytes) throw new Rejected(413, 'raditi_body')
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    const cleanup = () => {
      request.removeListener('data', data)
      request.removeListener('end', end)
      request.removeListener('error', fail)
      signal.removeEventListener('abort', abort)
    }
    const fail = (error: Error) => {
      cleanup()
      reject(error)
    }
    const abort = () => fail(new Error('Request body aborted'))
    const end = () => {
      cleanup()
      resolve(Buffer.concat(chunks, bytes))
    }
    const data = (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > maximumBytes) {
        fail(new Rejected(413, 'raditi_body'))
        request.resume()
      } else chunks.push(chunk)
    }
    request.on('data', data)
    request.once('end', end)
    request.once('error', fail)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

async function errorJson(
  upstream: StreamingEgressResponse,
  signal: AbortSignal,
): Promise<unknown | null> {
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for await (const chunk of upstream.body) {
      signal.throwIfAborted()
      bytes += chunk.byteLength
      if (bytes > limits.errorBytes) return null
      chunks.push(chunk)
    }
    return parseLlmJson(Buffer.concat(chunks, bytes))
  } catch {
    return null
  } finally {
    upstream.close()
  }
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  retryAfterMs = 1_000,
): void {
  if (response.destroyed) return
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    connection: 'close',
    ...(status === 503 ? { 'retry-after': String(Math.ceil(retryAfterMs / 1000)) } : {}),
  })
  response.end(
    JSON.stringify({
      error: { type: 'invalid_request_error', code, message: 'Gateway request is not allowed' },
    }),
  )
}

/** The subscription token exists only in credentials/upstream builders and the egress transport. */
export class LlmGateway {
  readonly server: Server
  readonly #routes = new Map<string, { backend: LlmBackend; route: LlmRoute }>()
  readonly #clients = new BlockList()
  readonly #tasks = new Set<Promise<void>>()
  readonly #controllers = new Set<AbortController>()
  readonly #sources = new Map<string, number>()
  readonly #shutdown = new AbortController()
  readonly #logger: GatewayLogger
  readonly #registry = createMetricsRegistry('llm')
  #closing = false
  #journalBlocked = 0
  #active = 0
  #counters = {
    requests: 0,
    refusals: 0,
    completed: 0,
    estimated: 0,
    persistenceRetries: 0,
    persistenceFailed: 0,
    usageLate: 0,
  }

  constructor(private readonly options: LlmGatewayOptions) {
    this.#logger = options.logger ?? { log: () => {}, warn: () => {} }
    const counters = this.#counters
    for (const key of Object.keys(counters) as Array<keyof typeof counters>)
      new Counter({
        name: `raditi_llm_${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_total`,
        help: `Aggregate subscription gateway ${key}`,
        registers: [this.#registry],
        collect() {
          this.reset()
          this.inc(counters[key])
        },
      })
    const active = () => this.#active
    new Gauge({
      name: 'raditi_llm_active_requests',
      help: 'Active subscription gateway requests',
      registers: [this.#registry],
      collect() {
        this.set(active())
      },
    })
    for (const client of options.config.clients)
      this.#clients.addSubnet(client.address, client.prefix, client.family)
    for (const backend of options.backends)
      for (const route of backend.routes) {
        const name = `${route.method} ${route.path}`
        if (this.#routes.has(name)) throw new Error('Duplicate LLM route')
        this.#routes.set(name, { backend, route })
      }
    this.server = createServer((request, response) => {
      const task = this.#handle(request, response)
      this.#tasks.add(task)
      void task.finally(() => this.#tasks.delete(task)).catch(() => {})
    })
    this.server.on('connect', (_request, socket) => socket.destroy())
    this.server.on('upgrade', (_request, socket) => socket.destroy())
    this.server.on('clientError', (_error, socket) => socket.destroy())
    this.server.headersTimeout = 10_000
    this.server.requestTimeout = 60_000
    this.server.maxHeadersCount = 64
  }

  stats() {
    return {
      ...this.#counters,
      activeRequests: this.#active,
      healthy: !this.#closing && this.#journalBlocked === 0,
    }
  }

  async listen(
    port = this.options.config.port,
    host = this.options.config.listenHost,
  ): Promise<AddressInfo> {
    this.server.listen(port, host)
    await once(this.server, 'listening')
    return this.server.address() as AddressInfo
  }

  async close(): Promise<void> {
    if (this.#closing) return
    this.#closing = true
    const timer = setTimeout(() => this.#shutdown.abort(), limits.shutdownMs)
    try {
      const closed = this.server.listening ? once(this.server, 'close') : Promise.resolve()
      if (this.server.listening) this.server.close()
      this.server.closeAllConnections()
      for (const controller of this.#controllers) controller.abort()
      await Promise.allSettled([...this.#tasks])
      await closed
    } finally {
      clearTimeout(timer)
      this.#shutdown.abort()
      this.#registry.clear()
    }
  }

  async #recordRefusal(keyId: string, reason: GatewayRefusal): Promise<void> {
    try {
      await abortable(
        withTimeout(
          this.options.store.refuse(keyId, reason),
          limits.refusalMs,
          'Gateway refusal journal timed out',
        ),
        this.#shutdown.signal,
      )
    } catch {
      this.#logger.warn(JSON.stringify({ event: 'llm_refusal_journal_failed' }))
    }
  }

  async #refuse(
    key: GatewayKey,
    backend: LlmBackend,
    response: ServerResponse,
    reason: GatewayRefusal,
    retryMs?: number,
    field?: string,
  ): Promise<void> {
    this.#counters.refusals += 1
    await this.#recordRefusal(key.keyId, reason)
    if (response.destroyed) return
    if (response.headersSent) {
      response.destroy()
      return
    }
    const refusal = backend.refusal(reason, retryMs)
    response.writeHead(refusal.status, Object.fromEntries(refusal.headers))
    if (field) {
      const payload = parseLlmJson(refusal.body)
      if (payload.error && typeof payload.error === 'object' && !Array.isArray(payload.error))
        payload.error.field = field
      response.end(JSON.stringify(payload))
    } else response.end(refusal.body)
  }

  async #persist(call: GatewayCall, finish: GatewayFinish): Promise<void> {
    const expires = Date.now() + limits.persistenceMs
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(), limits.persistenceMs)
    const persistenceSignal = AbortSignal.any([this.#shutdown.signal, deadline.signal])
    let blocked = false
    let event = 'llm_usage_journal_failed'
    try {
      while (!persistenceSignal.aborted && Date.now() < expires) {
        try {
          const saved = await abortable(
            this.options.store.finish(call.id, finish),
            persistenceSignal,
          )
          if (!saved) this.#counters.usageLate += 1
          return
        } catch (error) {
          // A write that can never succeed is not an unavailable journal: closing admission
          // for it would refuse every turn for good. The call stays open with its reservation.
          if (error instanceof GatewayRecordRejected) {
            event = 'llm_usage_journal_rejected'
            break
          }
          if (!blocked) {
            this.#journalBlocked += 1
            blocked = true
          }
          this.#counters.persistenceRetries += 1
          try {
            await delay(Math.min(1000, expires - Date.now()), undefined, {
              signal: persistenceSignal,
            })
          } catch {
            break
          }
        }
      }
      this.#counters.persistenceFailed += 1
      this.#logger.warn(JSON.stringify({ event }))
    } finally {
      clearTimeout(timer)
      // The unrecorded call stays open, so its reservation still counts until the collector
      // closes it as lost; while PostgreSQL stays down, the collector's health keeps
      // admission closed. This process alone never holds it closed past the retry window.
      if (blocked) this.#journalBlocked -= 1
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const selected = this.#routes.get(`${request.method ?? ''} ${request.url ?? ''}`)
    const monitor = request.method === 'GET' && ['/health', '/metrics'].includes(request.url ?? '')
    const control = request.method === 'POST' && request.url === '/internal/subscriptions/probe'
    const source = sourceAddress(request.socket.remoteAddress)
    const family = isIP(source)
    const controller = new AbortController()
    let key: GatewayKey | null = null
    let call: GatewayCall | undefined
    let upstream: StreamingEgressResponse | undefined
    let meter: ReturnType<LlmBackend['usageMeter']> | undefined
    let meterResult = emptyMeterResult()
    let signal: CallSignal | undefined
    let responseBytes = 0
    // The provider may have processed the request and spent quota: only then is usage estimated.
    let providerMayCharge = false
    let failed = false
    // The provider's stream reached its end: what closes the connection afterwards changes nothing.
    let ended = false
    let clientAborted = false
    let admitted = false
    let requestBytes = 0
    let field: string | undefined
    // Which limit of the key refused a `budget` admission; the answer does not tell them apart.
    let limit: string | undefined
    const started = Date.now()
    // When the provider last sent anything, and the deadline that its silence runs against.
    let upstreamAt: number | undefined
    let upstreamIdle: ReturnType<typeof setTimeout> | undefined
    const watchUpstream = () => {
      clearTimeout(upstreamIdle)
      upstreamIdle = setTimeout(() => controller.abort(), limits.upstreamIdleMs)
    }
    const upstreamProgress = () => {
      upstreamAt = Date.now()
      watchUpstream()
    }
    const abortClient = () => {
      if (!response.writableFinished) {
        // A later disconnect cannot turn an already observed provider/platform failure
        // into a billable client interruption while its refusal is being journaled. A client
        // leaving a provider that has not answered or has gone silent gave up on a platform
        // stall; only one leaving a live stream interrupted the generation itself.
        if (
          !failed &&
          !this.#closing &&
          !controller.signal.aborted &&
          upstreamAt !== undefined &&
          Date.now() - upstreamAt < limits.stallMs
        )
          clientAborted = true
        controller.abort()
      }
    }
    const timer = setTimeout(() => controller.abort(), control ? 20_000 : limits.requestMs)
    try {
      if (
        (!selected && !monitor && !control) ||
        !family ||
        !this.#clients.check(source, family === 4 ? 'ipv4' : 'ipv6') ||
        !this.options.config.hosts.includes((request.headers.host ?? '').toLowerCase()) ||
        this.#closing
      )
        throw new Rejected(403, 'raditi_route')
      const headers = clientHeaders(request, selected?.backend.clientHeaders ?? [])
      if (monitor) {
        if (
          Number(request.headers['content-length'] ?? 0) !== 0 ||
          request.headers['transfer-encoding']
        )
          throw new Rejected(400, 'raditi_body')
        if (request.url === '/health') {
          let healthy = this.stats().healthy && (this.options.ready?.() ?? true)
          try {
            healthy &&= await (this.options.health?.() ?? Promise.resolve(true))
          } catch {
            healthy = false
          }
          response.writeHead(healthy ? 200 : 503, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          })
          response.end(JSON.stringify({ status: healthy ? 'ok' : 'degraded' }))
        } else {
          const expected = this.options.metricsToken
          const provided = /^Bearer (\S+)$/i.exec(headers.get('authorization') ?? '')?.[1]
          if (!expected || !provided || !bearerTokenMatches(headers.get('authorization'), expected))
            throw new Rejected(401, 'raditi_key')
          response.writeHead(200, {
            'content-type': Registry.PROMETHEUS_CONTENT_TYPE,
            'cache-control': 'no-store',
          })
          response.end(await this.#registry.metrics())
        }
        return
      }
      if (control) {
        if (
          !this.options.metricsToken ||
          !bearerTokenMatches(headers.get('authorization'), this.options.metricsToken)
        )
          throw new Rejected(401, 'raditi_key')
        if (
          !this.options.lifecycle?.probeAccounts ||
          this.options.ready?.() === false ||
          this.#journalBlocked > 0 ||
          this.#active >= limits.requests ||
          (this.#sources.get(source) ?? 0) >= limits.requestsPerSource
        )
          throw new Rejected(503, 'raditi_busy')
        if (!/^application\/json(?:;|$)/i.test(headers.get('content-type') ?? ''))
          throw new Rejected(400, 'raditi_body')
        this.#active += 1
        this.#sources.set(source, (this.#sources.get(source) ?? 0) + 1)
        admitted = true
        this.#controllers.add(controller)
        request.once('aborted', abortClient)
        response.once('close', abortClient)
        const bytes = await abortable(
          readBody(request, controller.signal, 2 * 1024),
          controller.signal,
        )
        let asked: { accountIds: string[]; stale?: true }
        try {
          asked = z
            .strictObject({
              accountIds: z
                .array(z.uuid().transform((id) => id.toLowerCase()))
                .min(1)
                .max(10)
                .refine((ids) => new Set(ids).size === ids.length),
              // The snapshots have only grown old: the five-minute rule, not that of
              // unknown windows.
              stale: z.literal(true).optional(),
            })
            .parse(parseLlmJson(bytes))
        } catch {
          throw new Rejected(400, 'raditi_body')
        }
        const { lifecycle } = this.options
        if (asked.stale && !lifecycle.refreshAccount) throw new Rejected(503, 'raditi_busy')
        const probes: Promise<unknown> = asked.stale
          ? Promise.all(asked.accountIds.map((accountId) => lifecycle.refreshAccount!(accountId)))
          : lifecycle.probeAccounts!(asked.accountIds)
        await abortable(
          withTimeout(probes, 20_000, 'Subscription pool control timeout'),
          controller.signal,
        )
        if (!response.destroyed) {
          response.writeHead(204, { 'cache-control': 'no-store' })
          response.end()
        }
        return
      }
      if (!selected) throw new Rejected(403, 'raditi_route')
      if (
        this.#active >= limits.requests ||
        (this.#sources.get(source) ?? 0) >= limits.requestsPerSource
      )
        throw new Rejected(503, 'raditi_busy')
      const secret = /^Bearer (\S+)$/i.exec(headers.get('authorization') ?? '')?.[1]
      if (!secret || !LLM_KEY_PATTERN.test(secret)) throw new Rejected(401, 'raditi_key')
      this.#active += 1
      this.#sources.set(source, (this.#sources.get(source) ?? 0) + 1)
      admitted = true
      this.#controllers.add(controller)
      request.once('aborted', abortClient)
      response.once('close', abortClient)
      this.#counters.requests += 1
      const keyHash = turnKeyHash(secret)
      key = await abortable(this.options.store.lookup(keyHash, source), controller.signal)
      if (!key) throw new Rejected(401, 'raditi_key')
      if (key.backendId !== selected.backend.id) throw new Rejected(403, 'raditi_backend')
      try {
        selected.backend.validateClientHeaders(headers)
      } catch {
        throw new Rejected(403, 'raditi_client')
      }
      // Closed admission is checked once the key is known, so core can read why the turn
      // was refused, and the CLI waits out a collector pass or journal retry between tries.
      if (this.options.ready?.() === false || this.#journalBlocked > 0) {
        await this.#refuse(key, selected.backend, response, 'transient', limits.platformRetryMs)
        return
      }
      if (!/^application\/json(?:;|$)/i.test(headers.get('content-type') ?? '')) {
        await this.#refuse(key, selected.backend, response, 'policy')
        return
      }
      const body = await abortable(readBody(request, controller.signal), controller.signal)
      requestBytes = body.byteLength
      let normalized
      try {
        normalized = selected.backend.normalizeBody(selected.route, body, key)
      } catch (error) {
        // Only a DomainError names a policy violation. Anything else is the gateway's own
        // failure (a crashed rule, an exhausted stack) and must not end the turn as 'policy'.
        if (!isDomainError(error)) {
          this.#logger.warn(
            JSON.stringify({
              event: 'llm_body_normalization_failed',
              backend: selected.backend.id,
            }),
          )
          await this.#refuse(key, selected.backend, response, 'transient', limits.platformRetryMs)
          return
        }
        const path = rejectedPath(error)
        field = path?.slice(0, llmJsonLimits.errorPath) ?? 'unknown'
        await this.#refuse(
          key,
          selected.backend,
          response,
          'policy',
          undefined,
          path === null ? 'unknown' : sandboxPath(path),
        )
        return
      }
      const waitUntil = Date.now() + limits.accountWaitMs
      let probed = false
      let refreshed = !key.staleWindows
      while (true) {
        const pause = this.options.lifecycle?.pause(key)
        if (pause) {
          await this.#refuse(key, selected.backend, response, pause.reason, pause.retryAfterMs)
          return
        }
        const { lifecycle } = this.options
        if (!refreshed && lifecycle?.refreshAccount) {
          // A provider that reports its windows only when asked: the snapshot the key was
          // issued on has grown old. One refresh before the first call; an old snapshot closes
          // nothing by itself, so its failure or slowness leaves admission as it was.
          refreshed = true
          try {
            await abortable(
              withTimeout(
                lifecycle.refreshAccount(key.accountId),
                waitUntil - Date.now(),
                'Account refresh wait timed out',
              ),
              controller.signal,
            )
          } catch {
            controller.signal.throwIfAborted()
          }
        }
        // Admission commits a reservation. Always observe its result before reacting to cancellation.
        const admission = await this.options.store.admit({
          keyHash,
          source,
          backendId: selected.backend.id,
          route: selected.route,
          profile: key,
          requestBytes: body.byteLength,
          estimatedInputTokens: normalized.estInputTokens,
        })
        if (admission.kind === 'admitted') {
          call = admission.call
          controller.signal.throwIfAborted()
          break
        }
        controller.signal.throwIfAborted()
        if (admission.reason === 'unauthorized') throw new Rejected(401, 'raditi_key')
        if (admission.reason === 'backend') throw new Rejected(403, 'raditi_backend')
        if (admission.waitForSlot && Date.now() < waitUntil) {
          await delay(Math.min(250, waitUntil - Date.now()), undefined, {
            signal: controller.signal,
          })
          continue
        }
        const probeAccounts = this.options.lifecycle?.probeAccounts
        if (admission.probeAccount && !probed && probeAccounts && Date.now() < waitUntil) {
          // Unknown windows hold a running turn only until one fresh probe (shared and limited
          // per account by the pool); its outcome is whatever the next admission reads.
          probed = true
          try {
            await abortable(
              withTimeout(
                probeAccounts([key.accountId], { limitsSeenAt: admission.limitsSeenAt ?? null }),
                waitUntil - Date.now(),
                'Account probe wait timed out',
              ),
              controller.signal,
            )
          } catch {
            controller.signal.throwIfAborted()
          }
          continue
        }
        limit = admission.limit
        await this.#refuse(
          key,
          selected.backend,
          response,
          admission.reason,
          admission.retryAfterMs,
        )
        return
      }
      let credential: SubscriptionCredential
      try {
        credential = await abortable(
          this.options.credentials.get(call, selected.backend),
          controller.signal,
        )
      } catch {
        failed = true
        await this.#refuse(key, selected.backend, response, 'transient', 1000)
        return
      }
      let retried = false
      while (true) {
        const target = selected.backend.upstream(
          selected.route,
          normalized,
          headers,
          credential,
          call.clientIdentity,
        )
        meter = selected.backend.usageMeter()
        providerMayCharge = true
        // Liveness is per request: an answer to the previous one says nothing about this one.
        upstreamAt = undefined
        watchUpstream()
        try {
          upstream = await abortable(
            this.options.egress.request(
              {
                url: target.url,
                method: selected.route.method,
                headers: target.headers,
                body: normalized.body,
              },
              { signal: controller.signal },
            ),
            controller.signal,
          )
        } catch (error) {
          if (error instanceof EgressNotDelivered) providerMayCharge = false
          throw error
        }
        upstreamProgress()
        if (upstream.status >= 200 && upstream.status < 300) break
        // An HTTP error or redirect answers before any generation: no quota was spent.
        providerMayCharge = false
        if (upstream.status >= 300 && upstream.status < 400) throw new Error('Redirect refused')
        failed = true
        signal = selected.backend.classify(
          upstream.status,
          upstream.headers,
          await errorJson(upstream, controller.signal),
        )
        if (
          upstream.status !== 401 ||
          signal.kind !== 'auth' ||
          retried ||
          response.headersSent ||
          !selected.backend.refresh ||
          !this.options.lifecycle
        )
          break
        let refreshed: SubscriptionCredential | null = null
        try {
          // The shared refresher continues its durable rotation if this client stops waiting.
          refreshed = await abortable(
            withTimeout(
              this.options.lifecycle.refresh(
                call,
                selected.backend,
                this.options.credentials.versionOf?.(credential) ?? call.credentialVersion,
              ),
              15_000,
              'Token refresh wait timed out',
            ),
            controller.signal,
          )
        } catch {
          controller.signal.throwIfAborted()
        }
        if (!refreshed) break
        credential = refreshed
        retried = true
        failed = false
        signal = undefined
      }
      if (upstream.status < 200 || upstream.status >= 300) {
        await this.#refuse(
          key,
          selected.backend,
          response,
          refusalForSignal(signal!),
          signal?.kind === 'transient' ? signal.retryAfterMs : undefined,
        )
        return
      }
      const passedHeaders = [...responseHeaders, ...selected.backend.responseHeaders]
      if (
        !uniqueHeaders(upstream.rawHeaders, passedHeaders) ||
        !/^text\/event-stream(?:;|$)/i.test(upstream.headers.get('content-type') ?? '')
      )
        throw new Error('Invalid upstream headers')
      const nominated = new Set(
        (upstream.headers.get('connection') ?? '')
          .toLowerCase()
          .split(',')
          .map((name) => name.trim()),
      )
      const output: Record<string, string> = {}
      for (const name of passedHeaders) {
        const value = upstream.headers.get(name)
        if (value !== null && !nominated.has(name)) output[name] = value
      }
      response.writeHead(upstream.status, output)
      const inspector = selected.backend.streamInspector()
      const pending: Buffer[] = []
      let terminalSeen = false
      const decoder = createSseDecoder((event) => {
        const inspected = inspector.inspect(event)
        if (inspected.kind === 'invalid') throw new Error('Invalid upstream event')
        if (inspected.kind !== 'forward' && inspected.kind !== 'failure') return
        pending.push(eventBytes(inspected.event))
        if (inspected.kind === 'failure') {
          failed = true
          signal = inspected.signal
          return false
        }
        if (inspected.terminal) {
          terminalSeen = true
          return false
        }
      })
      for await (const chunk of upstream.body) {
        controller.signal.throwIfAborted()
        upstreamProgress()
        responseBytes += chunk.byteLength
        if (responseBytes > limits.responseBytes) throw new Error('Upstream response limit')
        meter.push(chunk)
        decoder.push(chunk)
        for (const event of pending.splice(0)) {
          if (!response.write(event)) {
            const stall = setTimeout(() => controller.abort(), limits.stallMs)
            try {
              await abortable(once(response, 'drain'), controller.signal)
            } finally {
              clearTimeout(stall)
            }
          }
        }
        if (failed || terminalSeen) break
      }
      clearTimeout(upstreamIdle)
      decoder.end()
      if (!failed && !terminalSeen) {
        // The provider closed the stream itself, before an event its adapter took for the end.
        // An adapter whose CLI cannot stop on that names the last event to send instead.
        const ending = inspector.end?.()
        if (ending) {
          failed = true
          signal = ending.signal
          response.write(eventBytes(ending.event))
        }
      }
      meterResult = meter.end()
      if (meterResult.outcome === 'incomplete' && !failed)
        throw new Error('Incomplete upstream response')
      // A CLI closes the connection as soon as it reads the last event, and reconnects after a
      // failure, while that refusal is still being journaled here: the call keeps the outcome
      // the provider gave it, whichever of the two comes first.
      ended = true
      if (signal) await this.#recordRefusal(key.keyId, refusalForSignal(signal))
      response.end()
    } catch (error) {
      failed = true
      if (error instanceof Rejected) {
        if (key && selected) {
          const reason = error.status === 503 ? 'transient' : 'policy'
          await this.#recordRefusal(key.keyId, reason)
        }
        sendError(response, error.status, error.code)
      } else if (key && selected && !controller.signal.aborted) {
        // A broken tunnel or stream is short-lived: the CLI retries it. A closed channel shows
        // as closed admission, and a confirmed region block as the provider's own signal;
        // without a proxy, a provider out of reach shows in the health answer alone.
        await this.#refuse(key, selected.backend, response, 'transient', limits.platformRetryMs)
      } else
        sendError(
          response,
          503,
          isDomainError(error) ? 'raditi_unavailable' : 'raditi_gateway',
          limits.platformRetryMs,
        )
    } finally {
      const aborted = controller.signal.aborted && !ended
      controller.abort()
      clearTimeout(timer)
      clearTimeout(upstreamIdle)
      upstream?.close()
      request.removeListener('aborted', abortClient)
      response.removeListener('close', abortClient)
      this.#controllers.delete(controller)
      try {
        if (call && selected) {
          try {
            if (meter) meterResult = meter.end()
          } catch {
            /* Keep the safe partial estimate. */
          }
          if (
            meterResult.usage &&
            Object.values(meterResult.usage).some((count) => count > 2_147_483_647)
          ) {
            meterResult.usage = null
            meterResult.usageIssue = 'invalid_usage'
          }
          const estimated = providerMayCharge && meterResult.usage === null
          const usage = providerMayCharge
            ? (meterResult.usage ?? {
                input: call.estimatedInputTokens,
                // Split like the reserve, so an estimate never outgrows it through its input.
                cacheRead: call.estimatedCacheReadTokens,
                cacheWrite: 0,
                output: Math.ceil(meterResult.deltaTextBytes / 3),
                reasoning: 0,
              })
            : { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }
          const platformFailure = failed || meterResult.outcome !== 'completed'
          const finish: GatewayFinish = {
            state: aborted
              ? 'aborted'
              : failed || meterResult.outcome === 'failed'
                ? 'failed'
                : 'completed',
            usage,
            estimated,
            billable: !estimated || !platformFailure || clientAborted,
            estimateReason: !estimated
              ? null
              : platformFailure
                ? clientAborted
                  ? 'aborted_client'
                  : 'aborted_platform'
                : meterResult.usageIssue,
            responseBytes,
            upstreamStatus:
              upstream && upstream.status >= 100 && upstream.status <= 599
                ? upstream.status
                : undefined,
            signal: signal ?? meterResult.signal ?? undefined,
            windows: upstream ? selected.backend.windowsFromHeaders(upstream.headers) : null,
          }
          if (estimated) this.#counters.estimated += 1
          else this.#counters.completed += 1
          await this.#persist(call, finish)
          if (this.options.lifecycle) {
            try {
              await abortable(
                withTimeout(
                  this.options.lifecycle.observe(call, finish),
                  20_000,
                  'Pool update timed out',
                ),
                this.#shutdown.signal,
              )
            } catch {
              this.#logger.warn(JSON.stringify({ event: 'llm_pool_update_failed' }))
            }
          }
          this.#logger.log(
            JSON.stringify({
              event: 'llm_call',
              path: selected.route.path,
              backend: selected.backend.id,
              model: call.modelSlug,
              status: upstream?.status ?? 503,
              aborted: finish.state === 'aborted',
              durationMs: Date.now() - started,
              requestBytes,
              responseBytes,
              // How the provider's answers are told apart afterwards: nothing else of them
              // is kept anywhere.
              ...signalLine(finish.signal),
            }),
          )
        } else if (selected && key) {
          this.#logger.log(
            JSON.stringify({
              event: 'llm_refusal',
              path: selected.route.path,
              backend: selected.backend.id,
              model: key.modelSlug,
              status: response.statusCode,
              field,
              limit,
              durationMs: Date.now() - started,
              requestBytes,
            }),
          )
        }
      } finally {
        if (admitted) {
          this.#active -= 1
          const remaining = (this.#sources.get(source) ?? 1) - 1
          if (remaining) this.#sources.set(source, remaining)
          else this.#sources.delete(source)
        }
      }
    }
  }
}

export const createLlmGateway = (options: LlmGatewayOptions): LlmGateway => new LlmGateway(options)
