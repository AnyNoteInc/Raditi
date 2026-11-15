import type { INestApplication } from '@nestjs/common'
import { MCP_STRATEGY, type McpStrategy } from '@rekog/mcp-nest'
import { json, type NextFunction, type Request, type Response } from 'express'

import { MCP_BODY_LIMIT } from '../access/mcp-policy.ts'
import { McpHttpExceptionFilter } from '../common/mcp-http-error.ts'
import type { SkillRelay } from '../skill-relay/skill-relay.ts'
import { MCP_SKILL_RELAY } from '../skill-relay/skill-relay.tokens.ts'

/**
 * Mounts the MCP transport on the app's HTTP server. Call before init()/listen(): Nest adds
 * its not-found handler on init, and routes mounted after it would never be reached.
 */
export async function mountMcp(app: INestApplication): Promise<void> {
  // The relay streams the body of a request as it came (docs/plan/81-mcp-server-credentials.md):
  // before the JSON parser of /mcp, which would read it whole and under its own limit.
  const relay = app.get<SkillRelay>(MCP_SKILL_RELAY)
  app.use('/mcp/skill', (req: Request, res: Response, next: NextFunction) => {
    relay.handle(req, res).catch(next)
  })
  app.use(json({ limit: MCP_BODY_LIMIT }))
  app.useGlobalFilters(new McpHttpExceptionFilter(app.getHttpAdapter()))
  const strategy = app.get<McpStrategy>(MCP_STRATEGY)
  strategy.setHttpAdapter(app.getHttpAdapter())
  app.connectMicroservice({ strategy })
  await app.startAllMicroservices()
}
