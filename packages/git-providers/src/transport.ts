import { request as httpsRequest } from 'node:https'
import type { LookupFunction } from 'node:net'

import { gitHostRefused, gitProviderFailed } from '@repo/domain'

// The HTTP of the git adapters (docs/plan/84-projects.md, ПР11, §4.5, §4.6). A request goes only to
// `https` on 443 (or to `https://localhost:<port>`, the fakes of a stand, which `resolvePublic`
// refuses unless the caller allows loopback). The host is resolved once per operation by the
// injected `resolvePublic` — core and web build it from @repo/ip-address and
// SANDBOX_EGRESS_REFUSED_SUBNETS; the adapter may not import those (§2) — and every request of the
// operation connects to that very address with the host name for TLS. No redirect is followed;
// time and size are bounded.

export interface GitHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  url: URL
  headers?: Record<string, string>
  body?: string
}

export interface GitHttpResponse {
  status: number
  headers: Headers
  body: Buffer
  /** The body was longer than the limit: `body` holds its tail when `tailBytes` was asked. */
  truncated: boolean
}

export interface GitSendLimits {
  timeoutMs: number
  maxBytes: number
  /** Keep only the last bytes of a long body and read at most `maxBytes` of it. */
  tailBytes?: number
  /**
   * A redirect is answered to the caller instead of refused: only the log of a GitHub job, whose
   * address is a redirect to a short-lived one the adapter checks and asks without the access
   * (§4.5). Nothing follows a redirect by itself.
   */
  redirect?: 'return'
}

/** Connects to `address` for `request.url.hostname`; the default speaks TLS with node:https. */
export type GitSend = (
  address: string,
  request: GitHttpRequest,
  limits: GitSendLimits,
) => Promise<GitHttpResponse>

export interface GitTransportOptions {
  /** The public address of `host`, or a refusal (GIT_HOST_REFUSED). Called once per operation. */
  resolvePublic(host: string): Promise<string>
  send?: GitSend
  /** An extra CA for the fakes of a stand (outside production only, like GIT_CA_FILE). */
  ca?: string
  timeoutMs?: number
  maxResponseBytes?: number
}

/** The requests of one operation: one resolution per host, the same address for all of them. */
export interface GitSession {
  request(request: GitHttpRequest, limits?: Partial<GitSendLimits>): Promise<GitHttpResponse>
}

export interface GitTransport {
  session(): GitSession
}

export const gitTransportDefaults = Object.freeze({
  timeoutMs: 20_000,
  maxResponseBytes: 4 * 1024 * 1024,
})

/** Refuses an address the adapters never call: not https, another port, credentials in it. */
export function assertGitUrl(url: URL): void {
  const localFake = url.hostname === 'localhost'
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    (!localFake && url.port !== '' && url.port !== '443')
  )
    throw gitHostRefused()
}

export function createGitTransport(options: GitTransportOptions): GitTransport {
  const send = options.send ?? nodeHttpsSend(options.ca)
  const base: GitSendLimits = {
    timeoutMs: options.timeoutMs ?? gitTransportDefaults.timeoutMs,
    maxBytes: options.maxResponseBytes ?? gitTransportDefaults.maxResponseBytes,
  }
  return {
    session() {
      const addresses = new Map<string, Promise<string>>()
      const addressOf = (host: string): Promise<string> => {
        let address = addresses.get(host)
        if (address === undefined) {
          address = options.resolvePublic(host)
          addresses.set(host, address)
        }
        return address
      }
      return {
        async request(request, limits) {
          assertGitUrl(request.url)
          const address = await addressOf(request.url.hostname)
          const response = await send(address, request, { ...base, ...limits })
          if (response.status >= 300 && response.status < 400 && limits?.redirect !== 'return')
            throw gitProviderFailed('a redirect is not followed', response.status)
          return response
        },
      }
    },
  }
}

/** A lookup that answers with the pinned address whatever DNS says now. */
export function pinnedLookup(address: string): LookupFunction {
  const family = address.includes(':') ? 6 : 4
  return ((
    _hostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    if (options?.all === true) callback(null, [{ address, family }])
    else callback(null, address, family)
  }) as unknown as LookupFunction
}

function nodeHttpsSend(ca: string | undefined): GitSend {
  return (address, request, limits) =>
    new Promise<GitHttpResponse>((resolve, reject) => {
      const { url } = request
      const req = httpsRequest(
        {
          method: request.method,
          protocol: 'https:',
          hostname: url.hostname,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          servername: url.hostname,
          lookup: pinnedLookup(address),
          headers: {
            ...request.headers,
            ...(request.body === undefined
              ? {}
              : { 'content-length': String(Buffer.byteLength(request.body)) }),
          },
          ...(ca === undefined ? {} : { ca }),
          timeout: limits.timeoutMs,
          agent: false,
        },
        (res) => {
          const chunks: Buffer[] = []
          let kept = 0
          let read = 0
          let truncated = false
          res.on('data', (chunk: Buffer) => {
            read += chunk.length
            if (read > limits.maxBytes) {
              truncated = true
              if (limits.tailBytes === undefined) {
                req.destroy()
                reject(gitProviderFailed('the answer is too large'))
                return
              }
              res.destroy()
              finish()
              return
            }
            chunks.push(chunk)
            kept += chunk.length
            if (limits.tailBytes !== undefined) {
              while (kept - chunks[0]!.length >= limits.tailBytes) kept -= chunks.shift()!.length
            }
          })
          res.on('end', finish)
          res.on('error', (error) => reject(gitProviderFailed(error.message)))
          let done = false
          function finish(): void {
            if (done) return
            done = true
            clearTimeout(overall)
            let body = Buffer.concat(chunks)
            if (limits.tailBytes !== undefined && body.length > limits.tailBytes) {
              body = body.subarray(body.length - limits.tailBytes)
              truncated = true
            }
            const headers = new Headers()
            for (const [name, value] of Object.entries(res.headers))
              if (typeof value === 'string') headers.set(name, value)
              else if (Array.isArray(value)) headers.set(name, value.join(', '))
            resolve({ status: res.statusCode ?? 0, headers, body, truncated })
          }
        },
      )
      // The socket timeout fires on idleness; this one bounds the whole exchange.
      const overall = setTimeout(() => {
        req.destroy()
        reject(gitProviderFailed('timeout'))
      }, limits.timeoutMs)
      req.on('timeout', () => {
        req.destroy()
        reject(gitProviderFailed('timeout'))
      })
      req.on('error', (error) => {
        clearTimeout(overall)
        reject(gitProviderFailed(error.message))
      })
      if (request.body !== undefined) req.write(request.body)
      req.end()
    })
}
