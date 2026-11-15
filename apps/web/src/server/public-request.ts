import 'server-only'

import type { LookupAddress } from 'node:dns'
import { lookup } from 'node:dns/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { request as httpsRequest } from 'node:https'

import {
  ipLiteral,
  isLoopbackAddress,
  publicAddressCheck,
  type RefusedSubnet,
} from '@repo/ip-address'

// A request of web to a server an owner named — an MCP server, its server of sign-in
// (docs/plan/80-mcp-server-credentials.md): the name is resolved once and every address it has must
// be public and outside the platform's subnets; the connection goes to the address that was
// checked, with the name as SNI and Host; no redirect is followed; the answer is bounded in bytes
// and in time.

const TIMEOUT_MS = 10_000
const ANSWER_BYTES = 1024 * 1024

export interface PublicAnswer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

export class PublicRequestRefused extends Error {
  readonly reason: 'unreachable' | 'address_refused' | 'too_large'

  constructor(reason: 'unreachable' | 'address_refused' | 'too_large') {
    super(reason)
    this.reason = reason
  }
}

export interface PublicRequestOptions {
  refusedSubnets: readonly RefusedSubnet[]
  /** Outside production, for tests and stands: a loopback server, over plain http as well. */
  allowLoopback: boolean
  resolve?: (host: string) => Promise<readonly LookupAddress[]>
}

export interface PublicRequest {
  url: string
  method: 'GET' | 'POST' | 'DELETE'
  headers?: Record<string, string>
  body?: string | null
  /** The answer is enough before its end: a stream that stays open after it. */
  enough?: (answer: PublicAnswer) => boolean
}

export type PublicRequester = (request: PublicRequest) => Promise<PublicAnswer>

export function publicRequester(options: PublicRequestOptions): PublicRequester {
  const isPublic = publicAddressCheck(options.refusedSubnets)
  const allowed = (address: string) =>
    isPublic(address) || (options.allowLoopback && isLoopbackAddress(address))
  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }))

  return async ({ url: text, method, headers = {}, body = null, enough }) => {
    const url = new URL(text)
    const secure = url.protocol === 'https:'
    if (!secure && !(options.allowLoopback && url.protocol === 'http:'))
      throw new PublicRequestRefused('unreachable')
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
    let addresses: readonly LookupAddress[]
    if (ipLiteral(host) !== undefined)
      addresses = [{ address: host, family: host.includes(':') ? 6 : 4 }]
    else
      addresses = await resolve(host).catch(() => {
        throw new PublicRequestRefused('unreachable')
      })
    if (addresses.length === 0) throw new PublicRequestRefused('unreachable')
    if (!addresses.every((entry) => allowed(entry.address)))
      throw new PublicRequestRefused('address_refused')
    const target = addresses[0]!
    return new Promise<PublicAnswer>((resolveAnswer, reject) => {
      const req = (secure ? httpsRequest : httpRequest)(
        {
          host: target.address,
          family: target.family === 6 ? 6 : 4,
          port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method,
          headers: { host: url.host, ...headers },
          timeout: TIMEOUT_MS,
          // The whole request, not only an idle socket.
          signal: AbortSignal.timeout(TIMEOUT_MS),
          ...(secure ? { servername: url.hostname } : {}),
        },
        (res) => {
          const chunks: Buffer[] = []
          let size = 0
          const answer = (): PublicAnswer => ({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
          res.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > ANSWER_BYTES) {
              req.destroy()
              reject(new PublicRequestRefused('too_large'))
              return
            }
            chunks.push(chunk)
            if (enough !== undefined) {
              const sofar = answer()
              if (enough(sofar)) {
                resolveAnswer(sofar)
                req.destroy()
              }
            }
          })
          res.on('end', () => resolveAnswer(answer()))
          res.on('error', () => reject(new PublicRequestRefused('unreachable')))
        },
      )
      req.on('timeout', () => req.destroy(new PublicRequestRefused('unreachable')))
      req.on('error', (error) =>
        reject(
          error instanceof PublicRequestRefused ? error : new PublicRequestRefused('unreachable'),
        ),
      )
      req.end(body ?? undefined)
    })
  }
}
