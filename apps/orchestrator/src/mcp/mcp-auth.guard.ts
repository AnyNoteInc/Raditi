import { Inject, Injectable, Logger, type CanActivate, type ExecutionContext } from '@nestjs/common'
import { SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server'
import { throttledLogger } from '@repo/observability'
import type { Request, Response } from 'express'

import { MCP_TOKEN_PATTERN } from '../llm/turn-key.ts'
import {
  MCP_ACCESS,
  MCP_REQUEST_ACCESS,
  type McpAccess,
  type McpAccessStore,
} from './mcp-access.ts'
import {
  MCP_SECURITY,
  mcpBodyAllowed,
  mcpErrorId,
  mcpHeadersAllowed,
  type McpSecurity,
} from './mcp-policy.ts'
import { McpHttpError, mcpErrorSummary } from './mcp-http-error.ts'

export type McpRequest = Request & { [MCP_REQUEST_ACCESS]?: McpAccess }

const unsupportedProtocolVersion = `Bad Request: Unsupported protocol version (supported versions: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')})`

@Injectable()
export class McpAuthGuard implements CanActivate {
  readonly #logger = new Logger('McpAuth')
  readonly #warn = throttledLogger((line) => this.#logger.warn(line))

  constructor(
    @Inject(MCP_ACCESS) private readonly access: McpAccessStore,
    @Inject(MCP_SECURITY) private readonly security: McpSecurity,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp()
    const req = http.getRequest<McpRequest>()
    const res = http.getResponse<Response>()
    res.setHeader('Cache-Control', 'no-store')
    const fail = (status: number, message: string): never => {
      if (status === 401) res.setHeader('WWW-Authenticate', 'Bearer realm="raditi-mcp"')
      throw new McpHttpError(status, mcpErrorId(req.body), message)
    }
    const seen = new Set<string>()
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      const name = req.rawHeaders[index]!.toLowerCase()
      if (!['authorization', 'host', 'origin', 'mcp-protocol-version'].includes(name)) continue
      if (seen.has(name)) fail(400, 'Invalid MCP headers')
      seen.add(name)
    }
    if (!mcpHeadersAllowed(req.headers, this.security)) fail(403, 'MCP origin is not allowed')
    if (req.originalUrl !== '/mcp') fail(400, 'Invalid MCP route')
    const protocolVersion = req.headers['mcp-protocol-version']
    if (
      protocolVersion !== undefined &&
      (typeof protocolVersion !== 'string' ||
        !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion))
    )
      // The SDK's own refusal shape, without echoing the header: a client that probes a newer
      // protocol (`server/discover` of the rmcp library) recognises it and falls back to legacy
      // initialize.
      throw new McpHttpError(400, null, unsupportedProtocolVersion)
    const authorization = req.headers.authorization ?? ''
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!MCP_TOKEN_PATTERN.test(token)) return fail(401, 'MCP token is invalid or expired')
    let authorized: McpAccess | null
    try {
      authorized = await this.access.authenticate(token)
    } catch (error) {
      // The class and codes only: never the token, its hash or the request.
      this.#warn('MCP authorization is unavailable', mcpErrorSummary(error))
      return fail(503, 'MCP authorization is unavailable')
    }
    if (!authorized) return fail(401, 'MCP token is invalid or expired')
    if (req.method === 'POST' && !mcpBodyAllowed(req.body, this.security.contentTools))
      fail(400, 'Invalid MCP request')
    // The SDK's Node/Web adapter rejects noncanonical IPv6 spellings when constructing a
    // Request URL. Only after exact-host validation, forward the same canonical authority.
    req.headers.host = new URL(`http://${req.headers.host}`).host
    req[MCP_REQUEST_ACCESS] = authorized
    return true
  }
}
