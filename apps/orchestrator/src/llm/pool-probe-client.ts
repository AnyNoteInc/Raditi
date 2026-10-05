import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList } from 'node:net'

import { z } from 'zod'

import { ipLiteral, isPrivateAddress } from '../config/private-address.ts'

const loopback = new BlockList()
loopback.addSubnet('127.0.0.0', 8, 'ipv4')
loopback.addAddress('::1', 'ipv6')
const unavailable = () => new Error('Subscription pool probe unavailable')

/** Origins never resolve arbitrary DNS or carry credentials, queries, fragments or paths. */
export function poolControlOrigin(value: string): string {
  const url = URL.parse(value)
  if (
    !url ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw unavailable()
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1'
  const literal = ipLiteral(url.hostname)
  if (
    !literal ||
    (!isPrivateAddress(literal) &&
      !loopback.check(literal, literal.includes(':') ? 'ipv6' : 'ipv4'))
  )
    throw unavailable()
  return url.origin
}

export type PoolProbeClient = (accountIds: readonly string[]) => Promise<void>

/** Core asks llm for quota snapshots without access to provider tokens or client request bodies. */
export function createPoolProbeClient(
  origin: string,
  token: string,
  options: { timeoutMs?: number } = {},
): PoolProbeClient {
  const endpoint = new URL('/internal/subscriptions/probe', poolControlOrigin(origin))
  if (!/^\S+$/.test(token) || token.length > 4_096) throw unavailable()
  const timeoutMs = z
    .number()
    .int()
    .min(1)
    .max(20_000)
    .parse(options.timeoutMs ?? 20_000)
  const transport = endpoint.protocol === 'https:' ? httpsRequest : httpRequest
  return async (accountIds) => {
    const parsed = z
      .array(z.uuid().transform((id) => id.toLowerCase()))
      .max(1_000)
      .safeParse(accountIds)
    if (!parsed.success) throw unavailable()
    const ids = [...new Set(parsed.data)]
    if (ids.length === 0) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      for (let index = 0; index < ids.length; index += 10) {
        controller.signal.throwIfAborted()
        const body = Buffer.from(JSON.stringify({ accountIds: ids.slice(index, index + 10) }))
        await new Promise<void>((resolve, reject) => {
          let settled = false
          const finish = (ok: boolean) => {
            if (settled) return
            settled = true
            if (ok) resolve()
            else reject(unavailable())
            outgoing.destroy()
          }
          const outgoing = transport(
            endpoint,
            {
              method: 'POST',
              agent: false,
              signal: controller.signal,
              headers: {
                authorization: `Bearer ${token}`,
                'content-type': 'application/json',
                'content-length': String(body.byteLength),
                accept: 'application/json',
              },
            },
            (response) => {
              if (response.statusCode !== 204) {
                response.destroy()
                finish(false)
                return
              }
              let bytes = 0
              response.on('data', (chunk: Buffer) => {
                bytes += chunk.byteLength
                if (bytes > 0) finish(false)
              })
              response.once('end', () => finish(bytes === 0))
              response.once('error', () => finish(false))
              response.once('aborted', () => finish(false))
            },
          )
          outgoing.once('error', () => finish(false))
          outgoing.once('upgrade', (_response, socket) => {
            socket.destroy()
            finish(false)
          })
          outgoing.end(body)
        })
      }
    } catch {
      throw unavailable()
    } finally {
      clearTimeout(timer)
    }
  }
}
