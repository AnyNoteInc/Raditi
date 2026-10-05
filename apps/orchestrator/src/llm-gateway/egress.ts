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
import { EgressNotDelivered } from './types.ts'

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
 * proxy tunnel or provider TLS failed before the HTTP request was written. A single-use refresh
 * token in such a request is still valid, so the outcome is not ambiguous, and a generation
 * request spent no quota (EgressNotDelivered).
 */
export class EgressNotSentError extends EgressNotDelivered {
  constructor() {
    super()
    this.name = 'EgressNotSentError'
  }
}

const failure = () => new Error('Subscription egress unavailable')
const notSent = () => new EgressNotSentError()

/**
 * HTTPS CONNECT with mTLS to the proxy and separately authenticated provider TLS. It sends only
 * the exact requests the given adapters declare; any other is refused as never sent.
 */
export function createEgressTransport(
  config: EgressConfig | null,
  backends: readonly LlmBackend[] = llmBackends,
): StreamingEgress {
  if (!config)
    return {
      request: async () => {
        throw notSent()
      },
    }
  const declared = backends.flatMap((backend) =>
    backend.egress.map((entry) => llmEgressOriginSchema.parse(entry)),
  )
  const origins = new Set(declared.map((entry) => entry.origin))
  const allowedRequests = new Set(declared.flatMap((entry) => entry.requests))
  let proxyTls: { ca: Buffer; cert: Buffer; key: Buffer }
  let providerCa: Buffer | readonly string[]
  try {
    proxyTls = {
      ca: readFileSync(config.caFile),
      cert: readFileSync(config.clientCertFile),
      key: readFileSync(config.clientKeyFile),
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
      const mapped = config.backendOrigins.get(original.origin)
      const target = mapped ? new URL(original.pathname, mapped) : original
      if (target.protocol !== 'https:') throw notSent()
      let outer: ClientRequest | undefined
      let inner: ClientRequest | undefined
      let tunnel: Socket | undefined
      let provider: TLSSocket | undefined
      let response: IncomingMessage | undefined
      // Set just before the HTTP request is written to the provider TLS session.
      let sent = false
      const lost = () => (sent ? failure() : notSent())
      const close = () => {
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
          const fail = () => {
            close()
            reject(lost())
          }
          const host = target.hostname.replace(/^\[(.*)\]$/, '$1')
          const proxyHost = config.proxyUrl.hostname.replace(/^\[(.*)\]$/, '$1')
          const authority = `${target.hostname}:${target.port || '443'}`
          outer = httpsRequest(config.proxyUrl, {
            method: 'CONNECT',
            path: authority,
            headers: { host: authority },
            agent: false,
            ...proxyTls,
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
            provider = tlsConnect({
              socket,
              servername: host,
              ca: providerCa as string[] | Buffer,
              rejectUnauthorized: true,
              ALPNProtocols: ['http/1.1'],
              minVersion: 'TLSv1.2',
            })
            provider.on('error', fail)
            socket.on('error', fail)
            provider.once('secureConnect', () => {
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
