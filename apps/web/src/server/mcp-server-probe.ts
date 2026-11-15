import 'server-only'

import type { McpServerCheck, McpServerProbe } from '@repo/trpc'

import {
  PublicRequestRefused,
  publicRequester,
  type PublicAnswer,
  type PublicRequestOptions,
} from '@/server/public-request'

// The check of an MCP server, before its key or its sign-in is kept (docs/plan/81-mcp-server-
// credentials.md, §3.4): `initialize` and `tools/list` with the owner's header or the access token
// of the sign-in, over a public request (public-request.ts). The key goes nowhere but this server.

const PROTOCOL_VERSION = '2025-06-18'

type Reason = Extract<McpServerCheck, { ok: false }>['reason']

class Refused extends Error {
  readonly reason: Reason

  constructor(reason: Reason) {
    super(reason)
    this.reason = reason
  }
}

export type McpServerProbeOptions = PublicRequestOptions

/** The JSON-RPC message of an answer: the body itself, or an event of a stream. */
export function messageOf(answer: PublicAnswer, id: number): Record<string, unknown> | null {
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

/** Why a server refused: a sign-in it names (RFC 9728), a key it does not take, or no server. */
function refusedBy(answer: PublicAnswer): Refused | null {
  if (answer.status === 401 || answer.status === 403)
    return new Refused(
      String(answer.headers['www-authenticate'] ?? '').includes('resource_metadata')
        ? 'needs_login'
        : 'unauthorized',
    )
  if (answer.status >= 300 && answer.status < 400) return new Refused('unreachable')
  if (answer.status < 200 || answer.status >= 300) return new Refused('not_mcp')
  return null
}

export function createMcpServerProbe(options: McpServerProbeOptions): McpServerProbe {
  const request = publicRequester(options)
  return async ({ url, header }) => {
    const call = (body: string | null, extra: Record<string, string>, id: number | null) =>
      request({
        url,
        method: body === null ? 'DELETE' : 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'user-agent': 'Raditi-MCP-Check/1',
          ...extra,
          ...(body === null ? {} : { 'content-type': 'application/json' }),
          ...(header === null ? {} : { [header.name]: header.value }),
        },
        body,
        // A stream may stay open after its answer: the answer is enough.
        ...(id === null
          ? {}
          : {
              enough: (answer: PublicAnswer) =>
                String(answer.headers['content-type'] ?? '').includes('text/event-stream') &&
                messageOf(answer, id) !== null,
            }),
      })
    try {
      const initialized = await call(
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
        1,
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
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
        follow,
        null,
      )
      const listed = await call(
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
        follow,
        2,
      )
      const second = refusedBy(listed)
      if (second) throw second
      const tools = (messageOf(listed, 2)?.result as { tools?: unknown } | undefined)?.tools
      if (!Array.isArray(tools)) throw new Refused('not_mcp')
      // The session ends here; a server that keeps none says so, and nothing waits for it.
      if (typeof session === 'string') await call(null, follow, null).catch(() => undefined)
      return { ok: true, tools: tools.length }
    } catch (error) {
      if (error instanceof Refused) return { ok: false, reason: error.reason }
      if (error instanceof PublicRequestRefused)
        return {
          ok: false,
          reason:
            error.reason === 'address_refused'
              ? 'address_refused'
              : error.reason === 'too_large'
                ? 'not_mcp'
                : 'unreachable',
        }
      return { ok: false, reason: 'unreachable' }
    }
  }
}
