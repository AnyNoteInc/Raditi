import type { INestApplication } from '@nestjs/common'
import {
  McpStrategy,
  StreamableHttpTransport,
  type McpTransportSecurityOptions,
} from '@rekog/mcp-nest'

import { ORCHESTRATOR_VERSION } from '../version.ts'

export const MCP_SERVER_NAME = 'raditi-mcp'
export const MCP_ENDPOINT = '/mcp'

/**
 * Host and Origin headers the gateway accepts: localhost, 127.0.0.1 and [::1] only, so a
 * web page cannot reach it through DNS rebinding. Anything else gets 403.
 */
export const MCP_TRANSPORT_SECURITY: McpTransportSecurityOptions = {
  allowedHosts: 'localhost',
  allowedOrigins: 'localhost',
}

/**
 * MCP gateway to client sites (spec §8), stateless Streamable HTTP on MCP_ENDPOINT.
 * No tools yet: they arrive in P6 from SiteAdapter.mcpTools. Until then there is no token
 * check, so the gateway serves local clients only and the mcp role does not start in
 * production (roles.ts).
 * TODO(P6): every request must carry the per-task MCP token scoped to one site and one task.
 * The self-mounted route bypasses Nest guards, so P6 moves it to an McpHttpControllerFor
 * controller with a guard that checks the token, and pins allowedHosts to sandbox-gw.
 */
export function createMcpStrategy(): McpStrategy {
  return new McpStrategy({
    name: MCP_SERVER_NAME,
    version: ORCHESTRATOR_VERSION,
    transports: [
      new StreamableHttpTransport({ endpoint: MCP_ENDPOINT, security: MCP_TRANSPORT_SECURITY }),
    ],
  })
}

/**
 * Mounts the MCP transport on the app's HTTP server. Call before init()/listen(): Nest adds
 * its not-found handler on init, and routes mounted after it would never be reached.
 */
export async function mountMcp(app: INestApplication, strategy: McpStrategy): Promise<void> {
  strategy.setHttpAdapter(app.getHttpAdapter())
  app.connectMicroservice({ strategy })
  await app.startAllMicroservices()
}
