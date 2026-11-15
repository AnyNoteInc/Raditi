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
import type { McpServerCheck, McpServerProbe } from '@repo/trpc'

// The check of an MCP server with a key, before the key is kept (docs/plan/80-mcp-server-
// credentials.md, §3.4): `initialize` and `tools/list` with the owner's header. Connects only to
// a public address the name resolved to, with the name as SNI and Host; follows no redirect; reads
// at most a megabyte of each answer. The key goes nowhere but this one server.

const TIMEOUT_MS = 10_000
const ANSWER_BYTES = 1024 * 1024
const PROTOCOL_VERSION = '2025-06-18'

interface Answer {
  status: number
  headers: IncomingHttpHeaders
  body: string
}

class Refused extends Error {
  readonly reason: Extract<McpServerCheck, { ok: false }>['reason']

  constructor(reason: Extract<McpServerCheck, { ok: false }>['reason']) {
    super(reason)
    this.reason = reason
  }
}

export interface McpServerProbeOptions {
  refusedSubnets: readonly RefusedSubnet[]
  /** Outside production, for tests and stands: a loopback server, over plain http as well. */
  allowLoopback: boolean
  resolve?: (host: string) => Promise<readonly LookupAddress[]>
}

/** The JSON-RPC message of an answer: the body itself, or the first event of a stream. */
function messageOf(answer: Answer, id: number): Record<string, unknown> | null {
  const type = String(answer.headers['content-type'] ?? '')
  const texts = type.includes('text/event-stream')
    ? answer.body
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
    : [answer.body]
  for (const text of texts) {
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed !== null && typeof parsed === 'object' && (parsed as { id?: unknown }).id === id)
        return parsed as Record<string, unknown>
    } catch {
      // Not this one.
    }
  }
  return null
}

export function createMcpServerProbe(options: McpServerProbeOptions): McpServerProbe {
  const isPublic = publicAddressCheck(options.refusedSubnets)
  const allowed = (address: string) =>
    isPublic(address) || (options.allowLoopback && isLoopbackAddress(address))
  const resolve = options.resolve ?? ((host: string) => lookup(host, { all: true, verbatim: true }))

  return async ({ url: text, header }) => {
    const url = new URL(text)
    const secure = url.protocol === 'https:'
    if (!secure && !(options.allowLoopback && url.protocol === 'http:'))
      return { ok: false, reason: 'unreachable' }
    try {
      const host = url.hostname.replace(/^\[(.*)\]$/, '$1')
      let addresses: readonly LookupAddress[]
      if (ipLiteral(host) !== undefined)
        addresses = [{ address: host, family: host.includes(':') ? 6 : 4 }]
      else
        addresses = await resolve(host).catch(() => {
          throw new Refused('unreachable')
        })
      if (addresses.length === 0) throw new Refused('unreachable')
      if (!addresses.every((entry) => allowed(entry.address))) throw new Refused('address_refused')
      const target = addresses[0]!

      const call = (
        method: 'POST' | 'DELETE',
        body: string | null,
        extra: Record<string, string>,
      ): Promise<Answer> =>
        new Promise((resolveAnswer, reject) => {
          const headers: Record<string, string> = {
            host: url.host,
            accept: 'application/json, text/event-stream',
            'user-agent': 'Raditi-MCP-Check/1',
            ...extra,
            ...(body === null ? {} : { 'content-type': 'application/json' }),
            ...(header === null ? {} : { [header.name]: header.value }),
          }
          const req = (secure ? httpsRequest : httpRequest)(
            {
              host: target.address,
              family: target.family === 6 ? 6 : 4,
              port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
              path: url.pathname,
              method,
              headers,
              timeout: TIMEOUT_MS,
              ...(secure ? { servername: url.hostname } : {}),
            },
            (res) => {
              const chunks: Buffer[] = []
              let size = 0
              res.on('data', (chunk: Buffer) => {
                size += chunk.length
                // A server of MCP answers a list in far less: more is not one.
                if (size > ANSWER_BYTES) {
                  req.destroy()
                  reject(new Refused('not_mcp'))
                  return
                }
                chunks.push(chunk)
              })
              res.on('end', () =>
                resolveAnswer({
                  status: res.statusCode ?? 0,
                  headers: res.headers,
                  body: Buffer.concat(chunks).toString('utf8'),
                }),
              )
              res.on('error', reject)
            },
          )
          req.on('timeout', () => req.destroy(new Refused('unreachable')))
          req.on('error', (error) =>
            reject(error instanceof Refused ? error : new Refused('unreachable')),
          )
          req.end(body ?? undefined)
        })

      const refusedBy = (answer: Answer): Refused | null => {
        if (answer.status === 401 || answer.status === 403)
          // A server that names where to sign in wants OAuth, not a header (RFC 9728).
          return new Refused(
            String(answer.headers['www-authenticate'] ?? '').includes('resource_metadata')
              ? 'needs_login'
              : 'unauthorized',
          )
        if (answer.status >= 300 && answer.status < 400) return new Refused('unreachable')
        if (answer.status < 200 || answer.status >= 300) return new Refused('not_mcp')
        return null
      }

      const initialized = await call(
        'POST',
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'raditi-check', version: '1' },
          },
        }),
        {},
      )
      const first = refusedBy(initialized)
      if (first) throw first
      const result = messageOf(initialized, 1)?.result as { protocolVersion?: unknown } | undefined
      if (typeof result?.protocolVersion !== 'string') throw new Refused('not_mcp')
      const session = initialized.headers['mcp-session-id']
      const follow: Record<string, string> = {
        'mcp-protocol-version': result.protocolVersion,
        ...(typeof session === 'string' ? { 'mcp-session-id': session } : {}),
      }
      await call(
        'POST',
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        follow,
      )
      const listed = await call(
        'POST',
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        follow,
      )
      const second = refusedBy(listed)
      if (second) throw second
      const tools = (messageOf(listed, 2)?.result as { tools?: unknown } | undefined)?.tools
      if (!Array.isArray(tools)) throw new Refused('not_mcp')
      // The session ends here; a server that keeps none says so, and nothing waits for it.
      if (typeof session === 'string') await call('DELETE', null, follow).catch(() => undefined)
      return { ok: true, tools: tools.length }
    } catch (error) {
      return { ok: false, reason: error instanceof Refused ? error.reason : 'unreachable' }
    }
  }
}
