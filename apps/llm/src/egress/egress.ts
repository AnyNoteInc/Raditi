import { Buffer } from 'node:buffer'
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { Agent, request as httpsRequest, type AgentOptions } from 'node:https'
import { isIP, type Socket } from 'node:net'
import { connect as tlsConnect, rootCertificates, type TLSSocket } from 'node:tls'

import {
  llmEgressOriginSchema,
  type EgressHttp,
  type EgressRequest,
  type LlmBackend,
} from '@repo/domain'
import { llmBackends } from '@repo/llm-backends'

import type { EgressConfig } from '../config/llm-config.ts'

/**
 * An egress failure after which no byte of the request can have reached the provider: the
 * channel was closed, or the tunnel or provider TLS session was never established. The call
 * then closes without a usage estimate. Any other egress failure may follow a delivered
 * request, and its estimate stays in the attempt ceiling.
 */
export class EgressNotDelivered extends Error {
  constructor() {
    super('Subscription egress unavailable')
    this.name = 'EgressNotDelivered'
  }
}

export interface StreamingEgressResponse {
  status: number
  headers: Headers
  rawHeaders: readonly string[]
  body: AsyncIterable<Uint8Array>
  /**
   * The caller has what it needs of a complete answer (docs/plan/94): what is left of the body is
   * read away, at most RELEASE_DRAIN_MS, and the connection goes back to the pool for the next
   * call of the same account. Afterwards `close()` and the caller's abort leave it alone.
   */
  release(): void
  /** Closes the connection unless `release()` gave it back; the answer is given up. */
  close(): void
}

export interface StreamingEgress {
  request(
    request: EgressRequest,
    options: { signal: AbortSignal },
  ): Promise<StreamingEgressResponse>
}

/**
 * The request provably never left this process for the provider: it was refused locally, or the
 * proxy tunnel, the role's own connection or provider TLS failed before the HTTP request was
 * written. The outcome is not ambiguous: nothing of the request reached the provider, and a
 * generation request spent no quota (EgressNotDelivered).
 */
export class EgressNotSentError extends EgressNotDelivered {
  constructor() {
    super()
    this.name = 'EgressNotSentError'
  }
}

/** The transport while `open()` holds. A closed gate sends nothing: a generation spends no quota. */
export function gatedEgress(transport: StreamingEgress, open: () => boolean): StreamingEgress {
  return {
    request: (...args) =>
      open() ? transport.request(...args) : Promise.reject(new EgressNotSentError()),
  }
}

const failure = () => new Error('Subscription egress unavailable')
const notSent = () => new EgressNotSentError()

// What egress-1 gives a tunnel to open (infra/egress/llm-egress.mjs): the role's own connection
// to a provider gets the same, so a host that does not answer fails as a request never sent.
const connectTimeoutMs = 10_000

/**
 * The pool of provider connections (docs/plan/94). A free connection lives at most this long:
 * well under the keep-alive of providers, so that one closing as a request is written — an
 * answer that may or may not have been delivered — stays rare. A shorter `Keep-Alive: timeout`
 * of the provider wins.
 */
export const FREE_CONNECTION_MS = 20_000
/** Free connections kept for one account at one origin. */
export const FREE_CONNECTIONS = 2
/**
 * Free connections kept in all: each holds one of the 64 tunnels of egress-1
 * (infra/egress/README.md), which new calls must still find.
 */
export const FREE_CONNECTIONS_TOTAL = 8
/** How long `release()` reads away the rest of an answer before it gives the connection up. */
export const RELEASE_DRAIN_MS = 2_000

/** What a request tells the pool's connection factory: where to, and how it is given up. */
interface ConnectionTarget {
  /** The pool key: path, origin and the hash of the account's credential header. */
  key: string
  host: string
  port: number
  authority: string
  signal: AbortSignal
  /** Without a proxy: whether the role's own connection was opened. */
  tell(established: boolean): void
}

/**
 * Keep-alive connections to the providers, one pool per account and origin. A new one is opened
 * as before — the tunnel through egress-1 or the role's own connection, then provider TLS — by
 * `open`; a free one waits `freeMs`. The hooks are the ones Node's Agent calls (their types in
 * @types/node do not say that createConnection may answer through its callback).
 */
function providerPool(
  open: (target: ConnectionTarget, done: (error: Error | null, socket?: TLSSocket) => void) => void,
  freeMs: number,
  freeTotal: () => number,
  options: AgentOptions,
): Agent {
  const agent = new Agent({ ...options, timeout: freeMs })
  const keepAlive = agent.keepSocketAlive.bind(agent) as unknown as (socket: Socket) => boolean
  const reuse = agent.reuseSocket.bind(agent) as (socket: Socket, request: ClientRequest) => void
  Object.assign(agent, {
    getName: (named?: { raditi?: ConnectionTarget }) => named?.raditi?.key ?? 'unkeyed',
    createConnection: (
      named: { raditi?: ConnectionTarget },
      done: (error: Error | null, socket?: TLSSocket) => void,
    ) => {
      if (named.raditi) open(named.raditi, done)
      else done(notSent())
      return undefined
    },
    keepSocketAlive: (socket: Socket) => {
      // Of a call that named no account: closed, never kept for another.
      for (const [name, list] of Object.entries(agent.sockets))
        if (name.startsWith(UNKEPT) && list?.includes(socket)) return false
      let free = 0
      for (const list of Object.values(agent.freeSockets)) free += list?.length ?? 0
      // Node sets the free time: `freeMs` (the agent's timeout), or a shorter `Keep-Alive:
      // timeout` of the provider less a second, and keeps none the provider closes within one.
      return free < freeTotal() && keepAlive(socket)
    },
    reuseSocket: (socket: Socket, request: ClientRequest) => {
      // A taken connection waits as long as its call: the gateway bounds that itself.
      socket.setTimeout(0)
      reuse(socket, request)
    },
  })
  return agent
}

/** The key of a call no pool keeps: a request without the credential header names no account. */
const UNKEPT = 'unkept'

/** The pool key: never the credential itself, only its hash. */
function poolKey(via: string, origin: string, headers: Headers): string {
  const credential = headers.get('authorization')
  if (credential === null) return `${UNKEPT} ${randomUUID()}`
  return `${via} ${origin} ${createHash('sha256').update(credential).digest('base64url')}`
}

/** The transport and its pool of provider connections, closed when the role stops. */
export interface PooledEgress extends StreamingEgress {
  /** Closes every free connection and keeps none after; one a call holds goes with that call. */
  close(): void
}

/**
 * The one way from the role to a provider, with separately authenticated provider TLS. It sends
 * only the exact requests the given adapters declare; any other is refused as never sent.
 *
 * With a proxy configured: HTTPS CONNECT with mTLS to the egress node, for every origin. Without
 * one: the role's own TCP connection, and only to an origin whose adapter declares that it
 * needs no egress node; any other origin is refused as never sent, as when nothing was
 * configured at all. The provider's certificate is verified the same way on both paths, under
 * the declared host name, so no address a resolver made up can receive a byte of a request.
 *
 * A connection stays open for the next call of the same account at the same origin (docs/plan/94,
 * ProviderPool) once its caller released a complete answer. A failure before the request had a
 * connection — the tunnel, provider TLS, the connect deadline — is a request never sent; any
 * later one, on a new connection or on a kept one, may follow a delivered request.
 */
export function createEgressTransport(
  config: EgressConfig,
  backends: readonly LlmBackend[] = llmBackends,
  options: {
    connectTimeoutMs?: number
    /** FREE_CONNECTION_MS: how long a free connection waits for the next call. */
    freeConnectionMs?: number
    /** RELEASE_DRAIN_MS: how long a released answer may take to end. */
    releaseDrainMs?: number
    /** FREE_CONNECTIONS_TOTAL: free connections kept in all. */
    freeConnectionsTotal?: number
    /**
     * Without a proxy: a connection of the role's own to a provider was opened (the TLS session
     * stands), or could not be. Never called for a request refused before any connection or
     * given up by its caller, nor for a call on a kept connection, and never on the proxy path,
     * whose channel has a probe of its own.
     */
    onDirectConnection?: (established: boolean) => void
  } = {},
): PooledEgress {
  const declared = backends.flatMap((backend) =>
    backend.egress.map((entry) => llmEgressOriginSchema.parse(entry)),
  )
  const origins = new Set(declared.map((entry) => entry.origin))
  const allowedRequests = new Set(declared.flatMap((entry) => entry.requests))
  const directOrigins = new Set(
    declared.filter((entry) => entry.direct === true).map((entry) => entry.origin),
  )
  // The rule below goes by origin, and a declaration must never read wider than written: one
  // that says nothing of going without the node cannot share its origin with one that does.
  for (const entry of declared)
    if (entry.direct !== true && directOrigins.has(entry.origin))
      throw new Error(`LLM backends disagree on the egress node for ${entry.origin}`)
  const connectDeadlineMs = options.connectTimeoutMs ?? connectTimeoutMs
  const releaseDrainMs = options.releaseDrainMs ?? RELEASE_DRAIN_MS
  let proxy: { url: URL; tls: { ca: Buffer; cert: Buffer; key: Buffer } } | null = null
  let providerCa: Buffer | readonly string[]
  try {
    if (config.proxyUrl !== null)
      proxy = {
        url: config.proxyUrl,
        tls: {
          ca: readFileSync(config.caFile),
          cert: readFileSync(config.clientCertFile),
          key: readFileSync(config.clientKeyFile),
        },
      }
    providerCa = config.upstreamCaFile ? readFileSync(config.upstreamCaFile) : rootCertificates
  } catch {
    throw failure()
  }

  /**
   * A new provider connection: the tunnel through the node or the role's own TCP, then provider
   * TLS. Its every failure, and its caller's abort, is a request never sent: no connection, no
   * byte of the request.
   */
  const open = (
    target: ConnectionTarget,
    done: (error: Error | null, socket?: TLSSocket) => void,
  ): void => {
    /** The CONNECT to the node, once it is sent. */
    const node: { outer?: ClientRequest } = {}
    let tunnel: Socket | undefined
    let provider: TLSSocket | undefined
    let settled = false
    const teardown = () => {
      provider?.destroy()
      tunnel?.destroy()
      node.outer?.destroy()
    }
    const fail = () => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      target.signal.removeEventListener('abort', fail)
      if (!target.signal.aborted) target.tell(false)
      teardown()
      done(notSent())
    }
    // One deadline for the name, the connection, the tunnel and the TLS session, as egress-1
    // gives a tunnel: past it nothing of the request has been written.
    const deadline = setTimeout(fail, connectDeadlineMs)
    deadline.unref()
    target.signal.addEventListener('abort', fail, { once: true })
    /** Provider TLS over the tunnel or over the role's own connection. */
    const secure = (transport: { socket: Socket } | { host: string; port: number }) => {
      try {
        provider = tlsConnect({
          ...transport,
          servername: target.host,
          ca: providerCa as string[] | Buffer,
          rejectUnauthorized: true,
          ALPNProtocols: ['http/1.1'],
          minVersion: 'TLSv1.2',
        })
      } catch {
        // Refused before any handshake, as a server name TLS does not take: nothing was
        // written, and inside the tunnel's event nobody else would hear of it.
        fail()
        return
      }
      provider.on('error', fail)
      provider.once('secureConnect', () => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        target.signal.removeEventListener('abort', fail)
        target.tell(true)
        const ready = provider!
        // From here the pool owns the session: its end takes the tunnel with it.
        ready.removeListener('error', fail)
        ready.on('error', () => ready.destroy())
        ready.once('close', () => {
          tunnel?.destroy()
          node.outer?.destroy()
        })
        done(null, ready)
      })
    }
    if (target.signal.aborted) return fail()
    if (proxy === null) {
      secure({ host: target.host, port: target.port })
      return
    }
    const proxyHost = proxy.url.hostname.replace(/^\[(.*)\]$/, '$1')
    const outer = httpsRequest(proxy.url, {
      method: 'CONNECT',
      path: target.authority,
      headers: { host: target.authority },
      agent: false,
      ...proxy.tls,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
      servername: isIP(proxyHost) ? 'egress-1.raditi.internal' : proxyHost,
    })
    node.outer = outer
    outer.on('error', fail)
    outer.on('response', fail)
    outer.on('connect', (answer, socket, head) => {
      tunnel = socket
      if (answer.statusCode !== 200 || head.length) {
        fail()
        return
      }
      socket.on('error', fail)
      secure({ socket })
    })
    outer.end()
  }

  // After close() a connection serves its call and is not kept.
  let closed = false
  const pool = providerPool(
    open,
    options.freeConnectionMs ?? FREE_CONNECTION_MS,
    () => (closed ? 0 : (options.freeConnectionsTotal ?? FREE_CONNECTIONS_TOTAL)),
    {
      keepAlive: true,
      maxFreeSockets: FREE_CONNECTIONS,
      scheduling: 'lifo',
    },
  )

  return {
    close: () => {
      closed = true
      for (const list of Object.values(pool.freeSockets))
        for (const socket of list ?? []) socket.destroy()
    },
    async request(input, { signal }) {
      if (signal.aborted) throw notSent()
      const original = URL.parse(input.url)
      if (
        !original ||
        !origins.has(original.origin) ||
        original.username ||
        original.password ||
        original.hash ||
        original.search ||
        !allowedRequests.has(`${input.method} ${original.href}`)
      )
        throw notSent()
      // No egress node: only the adapter's own word lets the role connect itself.
      if (proxy === null && !directOrigins.has(original.origin)) throw notSent()
      const mapped = config.backendOrigins.get(original.origin)
      const target = mapped ? new URL(original.pathname, mapped) : original
      if (target.protocol !== 'https:') throw notSent()
      let inner: ClientRequest | undefined
      let response: IncomingMessage | undefined
      let released = false
      let drain: ReturnType<typeof setTimeout> | undefined
      // The connection factory's own abort: a call given up while its connection opens.
      const connecting = new AbortController()
      // Set once the request has a connection: from then on it may be written to the provider.
      let sent = false
      const lost = () => (sent ? failure() : notSent())
      const close = () => {
        signal.removeEventListener('abort', onAbort)
        if (released) return
        connecting.abort()
        response?.destroy()
        inner?.destroy()
      }
      let rejectPending: ((error: Error) => void) | undefined
      const onAbort = () => {
        close()
        rejectPending?.(lost())
      }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        return await new Promise<StreamingEgressResponse>((resolve, reject) => {
          rejectPending = reject
          let told = false
          /** Without a proxy: said once, whether the role's own connection was opened. */
          const tell = (established: boolean) => {
            if (proxy !== null || told) return
            told = true
            options.onDirectConnection?.(established)
          }
          const fail = () => {
            close()
            reject(lost())
          }
          const headers = Object.fromEntries(input.headers)
          const blockedHeaders = new Set([
            'host',
            'connection',
            'content-length',
            'transfer-encoding',
            'upgrade',
            'proxy-authorization',
            'proxy-connection',
            'keep-alive',
            'te',
            'trailer',
            ...(input.headers.get('connection') ?? '')
              .toLowerCase()
              .split(',')
              .map((value) => value.trim()),
          ])
          for (const name of blockedHeaders) delete headers[name]
          headers.host = target.host
          headers['content-length'] = String(input.body?.byteLength ?? 0)
          const connection: ConnectionTarget = {
            key: poolKey(proxy === null ? 'direct' : 'node', target.origin, input.headers),
            host: target.hostname.replace(/^\[(.*)\]$/, '$1'),
            port: Number(target.port || 443),
            authority: `${target.hostname}:${target.port || '443'}`,
            signal: connecting.signal,
            tell,
          }
          inner = httpsRequest(
            target,
            { method: input.method, headers, agent: pool, raditi: connection } as Parameters<
              typeof httpsRequest
            >[1],
            (received) => {
              response = received
              const status = received.statusCode ?? 502
              // A redirect is the provider's answer like any other HTTP error: it is
              // returned, never followed, and the caller refuses it.
              if (status < 200) {
                fail()
                return
              }
              const normalized = new Headers()
              for (let index = 0; index < received.rawHeaders.length; index += 2)
                normalized.append(received.rawHeaders[index]!, received.rawHeaders[index + 1]!)
              rejectPending = undefined
              // Not destroyed when the caller stops reading: release() may keep the connection.
              const chunks = received.iterator({ destroyOnReturn: false })
              const body = (async function* () {
                try {
                  for await (const chunk of chunks) {
                    if (signal.aborted && !released) throw failure()
                    yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
                  }
                  // A body cut short — the caller's abort, a lost connection — is no answer.
                  if (!received.complete) throw failure()
                } catch {
                  close()
                  throw failure()
                }
              })()
              resolve({
                status,
                headers: normalized,
                rawHeaders: [...received.rawHeaders],
                body,
                release: () => {
                  if (released || response?.destroyed) return
                  released = true
                  signal.removeEventListener('abort', onAbort)
                  // What is left after the last event the caller read is read away: the pool takes
                  // the connection back at the end of the body, which must come soon.
                  if (!received.readableEnded) {
                    drain = setTimeout(() => received.destroy(), releaseDrainMs)
                    drain.unref()
                    received.once('end', () => clearTimeout(drain))
                    received.once('close', () => clearTimeout(drain))
                  }
                  received.resume()
                },
                close,
              })
            },
          )
          inner.once('socket', (socket: Socket) => {
            sent = true
            // A connection in a call waits as long as the call: the gateway bounds that itself.
            socket.setTimeout(0)
          })
          inner.on('error', fail)
          inner.on('upgrade', fail)
          inner.end(input.body)
          if (signal.aborted) onAbort()
        })
      } catch (error) {
        close()
        throw error instanceof EgressNotSentError ? notSent() : failure()
      }
    },
  }
}

/**
 * Control calls cannot consume an unbounded response while holding credentials in memory, and
 * a redirect is rejected as a request that was sent (the EgressHttp contract).
 */
export function createControlEgress(transport: StreamingEgress): EgressHttp {
  return {
    async request(input, options) {
      const response = await transport.request(input, options)
      try {
        if (response.status >= 300 && response.status < 400) throw failure()
        const chunks: Buffer[] = []
        let bytes = 0
        for await (const chunk of response.body) {
          bytes += chunk.byteLength
          if (bytes > 64 * 1024) throw failure()
          chunks.push(Buffer.from(chunk))
        }
        // Read to its end: the connection serves the next call (docs/plan/94).
        response.release()
        return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) }
      } catch {
        throw failure()
      } finally {
        response.close()
      }
    },
  }
}
