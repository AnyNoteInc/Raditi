import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import type { ClientRequest, IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
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
 * The one way from the role to a provider, with separately authenticated provider TLS. It sends
 * only the exact requests the given adapters declare; any other is refused as never sent.
 *
 * With a proxy configured: HTTPS CONNECT with mTLS to the egress node, for every origin. Without
 * one: the role's own TCP connection, and only to an origin whose adapter declares that it
 * needs no egress node; any other origin is refused as never sent, as when nothing was
 * configured at all. The provider's certificate is verified the same way on both paths, under
 * the declared host name, so no address a resolver made up can receive a byte of a request.
 */
export function createEgressTransport(
  config: EgressConfig,
  backends: readonly LlmBackend[] = llmBackends,
  options: {
    connectTimeoutMs?: number
    /**
     * Without a proxy: a connection of the role's own to a provider was opened (the TLS session
     * stands), or could not be. Never called for a request refused before any connection or
     * given up by its caller, and never on the proxy path, whose channel has a probe of its own.
     */
    onDirectConnection?: (established: boolean) => void
  } = {},
): StreamingEgress {
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
  return {
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
      let outer: ClientRequest | undefined
      let inner: ClientRequest | undefined
      let tunnel: Socket | undefined
      let provider: TLSSocket | undefined
      let response: IncomingMessage | undefined
      let connectDeadline: ReturnType<typeof setTimeout> | undefined
      // Set just before the HTTP request is written to the provider TLS session.
      let sent = false
      const lost = () => (sent ? failure() : notSent())
      const close = () => {
        clearTimeout(connectDeadline)
        signal.removeEventListener('abort', onAbort)
        response?.destroy()
        inner?.destroy()
        provider?.destroy()
        tunnel?.destroy()
        outer?.destroy()
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
            if (!sent && !signal.aborted) tell(false)
            close()
            reject(lost())
          }
          const host = target.hostname.replace(/^\[(.*)\]$/, '$1')
          const port = Number(target.port || 443)
          /** Provider TLS over the tunnel or over the role's own connection, then the request. */
          const secure = (transport: { socket: Socket } | { host: string; port: number }) => {
            try {
              provider = tlsConnect({
                ...transport,
                servername: host,
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
              clearTimeout(connectDeadline)
              tell(true)
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
              inner = httpsRequest(
                target,
                { method: input.method, headers, createConnection: () => provider!, signal },
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
                  const body = (async function* () {
                    try {
                      for await (const chunk of received) {
                        if (signal.aborted) throw failure()
                        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
                      }
                    } catch {
                      throw failure()
                    } finally {
                      close()
                    }
                  })()
                  resolve({
                    status,
                    headers: normalized,
                    rawHeaders: [...received.rawHeaders],
                    body,
                    close,
                  })
                },
              )
              inner.on('error', fail)
              inner.on('upgrade', fail)
              sent = true
              inner.end(input.body)
            })
          }
          if (proxy === null) {
            // One deadline for the name, the connection and the TLS session, as egress-1 gives
            // a tunnel: past it nothing of the request has been written.
            connectDeadline = setTimeout(fail, connectDeadlineMs)
            connectDeadline.unref()
            secure({ host, port })
            if (signal.aborted) onAbort()
            return
          }
          const proxyHost = proxy.url.hostname.replace(/^\[(.*)\]$/, '$1')
          const authority = `${target.hostname}:${target.port || '443'}`
          outer = httpsRequest(proxy.url, {
            method: 'CONNECT',
            path: authority,
            headers: { host: authority },
            agent: false,
            ...proxy.tls,
            rejectUnauthorized: true,
            minVersion: 'TLSv1.3',
            servername: isIP(proxyHost) ? 'egress-1.raditi.internal' : proxyHost,
            signal,
          })
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
        return { status: response.status, headers: response.headers, body: Buffer.concat(chunks) }
      } catch {
        throw failure()
      } finally {
        response.close()
      }
    },
  }
}
