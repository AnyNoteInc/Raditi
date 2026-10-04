import type { INestApplication } from '@nestjs/common'
import {
  MCP_STRATEGY,
  McpStrategy,
  StreamableHttpTransport,
  type McpTransportSecurityOptions,
} from '@rekog/mcp-nest'
import { json } from 'express'

import { ORCHESTRATOR_VERSION } from '../version.ts'
import { MCP_BODY_LIMIT, type McpSecurity } from './mcp-policy.ts'
import { McpHttpExceptionFilter } from './mcp-http-error.ts'

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
    version: ORCHESTRATOR_VERSION,
    transports: [transport],
    // Off at every level: mcp-nest logs a throwing tool's message and whole request errors,
    // which may carry site content. McpAuthGuard and McpHttpExceptionFilter log failures by
    // class and code instead.
    logging: false,
    // mcp-nest inserts logging:{} when the property is absent. An explicit undefined
    // prevents that default and omits the unsupported capability from initialize JSON.
    capabilities: { logging: undefined },
  })
  return { strategy, handlers: transport.httpHandlers }
}

/**
 * Mounts the MCP transport on the app's HTTP server. Call before init()/listen(): Nest adds
 * its not-found handler on init, and routes mounted after it would never be reached.
 */
export async function mountMcp(app: INestApplication): Promise<void> {
  app.use(json({ limit: MCP_BODY_LIMIT }))
  app.useGlobalFilters(new McpHttpExceptionFilter(app.getHttpAdapter()))
  const strategy = app.get<McpStrategy>(MCP_STRATEGY)
  strategy.setHttpAdapter(app.getHttpAdapter())
  app.connectMicroservice({ strategy })
  await app.startAllMicroservices()
}
