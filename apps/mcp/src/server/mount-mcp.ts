import type { INestApplication } from '@nestjs/common'
import { MCP_STRATEGY, type McpStrategy } from '@rekog/mcp-nest'
import { json } from 'express'

import { MCP_BODY_LIMIT } from '../access/mcp-policy.ts'
import { McpHttpExceptionFilter } from '../common/mcp-http-error.ts'

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
