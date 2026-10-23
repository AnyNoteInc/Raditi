import {
  McpStrategy,
  StreamableHttpTransport,
  type McpTransportSecurityOptions,
} from '@rekog/mcp-nest'

import type { McpSecurity } from '../access/mcp-policy.ts'
import { MCP_REQUEST_TOOLS, type McpRequest } from '../access/mcp-request.ts'
import { MCP_VERSION } from '../version.ts'

export const MCP_SERVER_NAME = 'raditi-mcp'
export const MCP_ENDPOINT = '/mcp'

/** A fresh transport per Nest app; only the guarded controller owns the HTTP route. */
export function createMcpRuntime(security: McpSecurity) {
  const transportSecurity: McpTransportSecurityOptions = {
    allowedHosts: [...security.allowedHosts],
    allowedOrigins: security.allowLocalOrigin ? 'localhost' : [],
  }
  const transport = new StreamableHttpTransport({
    security: transportSecurity,
    statefulMode: false,
    protocol: 'legacy-only',
    mount: false,
  })
  const strategy = new McpStrategy({
    name: MCP_SERVER_NAME,
    version: MCP_VERSION,
    transports: [transport],
    // Off at every level: mcp-nest logs a throwing tool's message and whole request errors,
    // which may carry site content. McpAuthGuard and McpHttpExceptionFilter log failures by
    // class and code instead.
    logging: false,
    // mcp-nest inserts logging:{} when the property is absent. An explicit undefined
    // prevents that default and omits the unsupported capability from initialize JSON.
    capabilities: { logging: undefined },
    // The tool families the guard admitted for this request are the "scopes" of its caller:
    // tools/list shows a tool of @ToolScopes only to a request of its family, and tools/call
    // refuses it to any other. Nothing of the request but the guard's own symbol is read.
    resolveUser: (raw) => {
      const families = (raw as McpRequest | undefined)?.[MCP_REQUEST_TOOLS]
      return families ? { scopes: [...families] } : undefined
    },
  })
  describeToolsWithoutSchemes(strategy)
  return { strategy, handlers: transport.httpHandlers }
}

/** What every tool of the list says of its authorization: what it said before families. */
export const MCP_TOOL_SECURITY_SCHEMES = [{ type: 'noauth' }] as const

/**
 * mcp-nest describes a tool of `@ToolScopes` to the client as OAuth 2 with those scopes
 * (`_meta.securitySchemes`). A family is this role's own split of what one turn token may call,
 * not an OAuth scope a client could ask for, and a client that reads such a scheme could start
 * an authorization flow of its own: every tool keeps the description the agent's client was
 * checked with before families existed (`verify:agent-content`). Fails at start, never quietly,
 * when mcp-nest no longer has the service this replaces.
 */
function describeToolsWithoutSchemes(strategy: McpStrategy): void {
  const service = (strategy as unknown as { authService?: { generateSecuritySchemes?: unknown } })
    .authService
  if (!service || typeof service.generateSecuritySchemes !== 'function')
    throw new Error('mcp-nest: the tool authorization service is not where it was')
  service.generateSecuritySchemes = () => MCP_TOOL_SECURITY_SCHEMES.map((scheme) => ({ ...scheme }))
}
