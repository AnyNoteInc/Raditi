import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpsRequest, type RequestOptions } from 'node:https'
import { request as httpRequest } from 'node:http'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import { Logger } from '@nestjs/common'
import { SKILL_RELAY_PATH } from '@repo/domain'
import { throttledLogger } from '@repo/observability'
import { MCP_TOKEN_PATTERN } from '@repo/turn-keys'

import { mcpErrorSummary } from '../common/mcp-http-error.ts'
import type { McpAccessStore, McpTurnAccess } from '../access/mcp-access.ts'
import { mcpHeadersAllowed, type McpSecurity } from '../access/mcp-policy.ts'
import { maskingStream } from './masking.ts'
import type { SkillSecretRead, SkillSecrets } from './skill-secrets.ts'
import type { RelayedServer, SkillServerStore } from './skill-servers.ts'
import { RelayRefusal, type upstreamResolver } from './upstream.ts'

// The relay of MCP servers with authorization (docs/plan/80-mcp-server-credentials.md, §3.2): the
// turn's CLI calls /mcp/skill/<name> on the gateway of its sandbox with its MCP token; the relay
// admits the token as /mcp does, finds the server of the turn's site by its name, reads its secret
// from Vault and makes the server's request itself, over its own TLS, with the owner's header.
// The answer streams back with the secret taken out of it. Nothing of the request or the answer is
// logged: the name, the host, the status, the bytes and the time.

export const skillRelayLimits = Object.freeze({
  requestBytes: 4 * 1024 * 1024,
  responseBytes: 64 * 1024 * 1024,
  timeoutMs: 10 * 60 * 1000,
  /** Requests of one turn key at a time. */
  perKey: 8,
  /** How often a working server's state is written again. */
  recordOkMs: 5 * 60 * 1000,
})

const METHODS = new Set(['GET', 'POST', 'DELETE'])
/** What the CLI's request may carry on: the protocol's own headers. */
const FORWARDED_REQUEST = [
  'content-type',
  'accept',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
]
/** What the server's answer may carry back. */
const FORWARDED_RESPONSE = ['content-type', 'mcp-session-id', 'mcp-protocol-version']
const USER_AGENT = 'Raditi-MCP-Relay/1'

type Resolve = ReturnType<typeof upstreamResolver>

export interface SkillRelayDeps {
  access: McpAccessStore
  security: McpSecurity
  servers: SkillServerStore
  secrets: Pick<SkillSecrets, 'read' | 'forget'>
  resolve: Resolve
  now?: () => Date
}

/** A refusal the CLI reads: JSON-RPC, so the agent can tell the client what happened. */
function failure(res: ServerResponse, status: number, message: string) {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } })
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** The texts the agent passes on to the client (rule 10): who must do what. */
export const relayText = Object.freeze({
  refused: (name: string) =>
    `MCP-сервер «${name}» не принял ключ. Владелец проекта может заменить ключ или войти заново в «MCP-серверах».`,
  missing: (name: string) =>
    `У MCP-сервера «${name}» нет ключа. Владелец проекта может задать его в «MCP-серверах».`,
  unreachable: (name: string) => `MCP-сервер «${name}» сейчас не отвечает. Попробуйте позже.`,
  addressRefused: (name: string) =>
    `Адрес MCP-сервера «${name}» ведёт во внутреннюю сеть, туда Радити не ходит.`,
})

function bounded(limit: number, onOver: () => void) {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, done) {
      seen += chunk.length
      if (seen > limit) {
        onOver()
        done(new Error('over the limit'))
        return
      }
      done(null, chunk)
    },
  })
}

export class SkillRelay {
  readonly #logger = new Logger('McpSkillRelay')
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))
  readonly #active = new Map<string, number>()
  readonly #recorded = new Map<string, number>()

  constructor(private readonly deps: SkillRelayDeps) {}

  async handle(
    req: IncomingMessage & { originalUrl?: string },
    res: ServerResponse,
  ): Promise<void> {
    const name = SKILL_RELAY_PATH.exec(req.originalUrl ?? req.url ?? '')?.[1]
    if (name === undefined) return failure(res, 404, 'Not found')
    const seen = new Set<string>()
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const header = req.rawHeaders[index]!.toLowerCase()
      if (!['authorization', 'host', 'origin', 'content-length'].includes(header)) continue
      if (seen.has(header)) return failure(res, 400, 'Invalid MCP headers')
      seen.add(header)
    }
    if (!mcpHeadersAllowed(req.headers, this.deps.security))
      return failure(res, 403, 'MCP origin is not allowed')
    if (!METHODS.has(req.method ?? '')) return failure(res, 405, 'Method not allowed')
    const authorization = req.headers.authorization ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!MCP_TOKEN_PATTERN.test(token)) return failure(res, 401, 'MCP token is invalid or expired')
    let access: McpTurnAccess | null
    try {
      access = await this.deps.access.authenticate(token)
    } catch (error) {
      this.#warn('MCP relay authorization is unavailable', mcpErrorSummary(error))
      return failure(res, 503, 'MCP authorization is unavailable')
    }
    if (access === null) return failure(res, 401, 'MCP token is invalid or expired')
    if (access.siteId === null) return failure(res, 404, 'Not found')
    const siteId = access.siteId
    const server = await this.deps.servers.find(siteId, name)
    if (server === null) return failure(res, 404, 'Not found')
    const active = this.#active.get(access.keyId) ?? 0
    if (active >= skillRelayLimits.perKey) return failure(res, 429, 'Too many MCP requests')
    this.#active.set(access.keyId, active + 1)
    try {
      await this.#relay(req, res, { siteId, name, server })
    } finally {
      const left = (this.#active.get(access.keyId) ?? 1) - 1
      if (left > 0) this.#active.set(access.keyId, left)
      else this.#active.delete(access.keyId)
    }
  }

  async #relay(
    req: IncomingMessage,
    res: ServerResponse,
    { siteId, name, server }: { siteId: string; name: string; server: RelayedServer },
  ): Promise<void> {
    const started = Date.now()
    const url = new URL(server.url)
    const read = await this.deps.secrets.read(siteId, name)
    const header = read === null ? null : authorizationOf(server, read)
    if (read === null || header === null) {
      await this.#record(siteId, name, 'failed', 'secret_missing')
      return failure(res, 502, relayText.missing(name))
    }
    let target: Awaited<ReturnType<Resolve>>
    try {
      target = await this.deps.resolve(url)
    } catch (error) {
      const code = error instanceof RelayRefusal ? error.code : 'unreachable'
      this.#log(name, url, code, 0, started)
      return failure(
        res,
        502,
        code === 'address_refused' ? relayText.addressRefused(name) : relayText.unreachable(name),
      )
    }
    const values = secretValuesOf(read)
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > skillRelayLimits.requestBytes)
      return failure(res, 413, 'Request body is too large')

    const headers: Record<string, string> = { 'user-agent': USER_AGENT, host: url.host }
    for (const name of FORWARDED_REQUEST) {
      const value = req.headers[name]
      if (typeof value === 'string') headers[name] = value
    }
    headers[header.name] = header.value
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), skillRelayLimits.timeoutMs)
    const abort = () => controller.abort()
    req.on('aborted', abort)
    res.on('close', abort)
    // To the address that was checked; the server's name is its SNI, the name of its certificate
    // and its Host — the connection never resolves the name again.
    const secure = url.protocol === 'https:'
    const options: RequestOptions = {
      host: target.address,
      family: target.family,
      port: url.port === '' ? (secure ? 443 : 80) : Number(url.port),
      path: url.pathname,
      method: req.method,
      headers,
      signal: controller.signal,
      ...(secure ? { servername: url.hostname } : {}),
    }
    const request = secure ? httpsRequest : httpRequest
    let status = 0
    let bytes = 0
    try {
      await new Promise<void>((resolve, reject) => {
        const upstream = request(options, (response) => {
          status = response.statusCode ?? 502
          if (status >= 300 && status < 400) {
            response.resume()
            failure(res, 502, relayText.unreachable(name))
            resolve()
            return
          }
          if (status === 401 || status === 403) {
            response.resume()
            this.deps.secrets.forget(siteId, name)
            void this.#record(
              siteId,
              name,
              server.authKind === 'oauth' ? 'needs_login' : 'failed',
              'unauthorized',
            ).then(() => {
              failure(res, 502, relayText.refused(name))
              resolve()
            }, reject)
            return
          }
          if (status < 400) void this.#record(siteId, name, 'ok', null)
          const answer: Record<string, string> = { 'cache-control': 'no-store' }
          for (const header of FORWARDED_RESPONSE) {
            const value = response.headers[header]
            if (typeof value === 'string') answer[header] = value
          }
          res.writeHead(status, answer)
          const counted = new Transform({
            transform(chunk: Buffer, _encoding, done) {
              bytes += chunk.length
              done(null, chunk)
            },
          })
          pipeline(
            response,
            bounded(skillRelayLimits.responseBytes, abort),
            maskingStream(values),
            counted,
            res,
          ).then(resolve, reject)
        })
        upstream.on('error', reject)
        pipeline(req, bounded(skillRelayLimits.requestBytes, abort), upstream).catch(reject)
      })
    } catch {
      if (!res.headersSent) failure(res, 502, relayText.unreachable(name))
      else res.destroy()
    } finally {
      clearTimeout(timer)
      req.off('aborted', abort)
      res.off('close', abort)
      this.#log(name, url, status === 0 ? 'unreachable' : String(status), bytes, started)
    }
  }

  async #record(
    siteId: string,
    name: string,
    state: 'ok' | 'needs_login' | 'failed',
    error: string | null,
  ) {
    const key = `${siteId}/${name}`
    const now = (this.deps.now ?? (() => new Date()))()
    if (state === 'ok') {
      const last = this.#recorded.get(key)
      if (last !== undefined && now.getTime() - last < skillRelayLimits.recordOkMs) return
      this.#recorded.set(key, now.getTime())
    } else this.#recorded.delete(key)
    try {
      await this.deps.servers.record(siteId, name, { state, error, at: now })
    } catch (caught) {
      this.#warn('MCP relay could not record a server state', mcpErrorSummary(caught))
    }
  }

  #log(name: string, url: URL, outcome: string, bytes: number, started: number) {
    this.#logger.log(
      `relayed skill=${name} host=${url.hostname} outcome=${outcome} bytes=${bytes} ms=${Date.now() - started}`,
    )
  }
}

/** The header the server gets: the owner's, or the access token of the sign-in. */
function authorizationOf(server: RelayedServer, read: SkillSecretRead) {
  const { secret } = read
  if (server.authKind === 'header' && 'value' in secret && server.headerName !== null)
    return { name: server.headerName.toLowerCase(), value: secret.value }
  if (server.authKind === 'oauth' && 'accessToken' in secret)
    return { name: 'authorization', value: `Bearer ${secret.accessToken}` }
  return null
}

/** Every secret value of a server: never in what it answers. */
function secretValuesOf(read: SkillSecretRead): string[] {
  const { secret } = read
  return 'value' in secret
    ? [secret.value]
    : [secret.accessToken, secret.refreshToken ?? '', secret.clientSecret ?? '']
}
