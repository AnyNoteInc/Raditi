import { Ctx } from '@nestjs/microservices'
import { McpController, Tool, type McpContext } from '@rekog/mcp-nest'
import { z } from 'zod'

import { MCP_REQUEST_ACCESS } from './mcp-access.ts'
import type { McpRequest } from './mcp-auth.guard.ts'

@McpController()
export class McpToolsController {
  @Tool({
    name: 'site_info',
    description: 'Read the registered public URL and stack of the site assigned to this turn.',
    parameters: z.strictObject({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  })
  siteInfo(@Ctx() context: McpContext) {
    const access = context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]
    if (!access)
      return { isError: true, content: [{ type: 'text', text: 'MCP authorization is required' }] }
    // No credentials, internal ids, site owner or third-party content go to the agent.
    const data = { url: access.url, stack: access.stack }
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
}
