import type { Request } from 'express'

import type { McpAccess } from './mcp-access.ts'
import type { McpToolFamily } from './mcp-policy.ts'

/** A Symbol cannot be supplied by a JSON body or an HTTP header. */
export const MCP_REQUEST_ACCESS = Symbol('MCP_REQUEST_ACCESS')
/** The tool families of the request (mcpToolFamiliesOf), set by the guard with the access. */
export const MCP_REQUEST_TOOLS = Symbol('MCP_REQUEST_TOOLS')

/** An MCP request after McpAuthGuard: what it admitted rides on the request under its symbols. */
export type McpRequest = Request & {
  [MCP_REQUEST_ACCESS]?: McpAccess
  /** The tool families of this request's scope: what tools/list shows and tools/call admits. */
  [MCP_REQUEST_TOOLS]?: readonly McpToolFamily[]
}
