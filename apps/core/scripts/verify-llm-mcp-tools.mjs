// The tools a stand's synthetic MCP server lists: the ones of the role mcp's production
// profile, read from the build, so that a CLI declares them to the model as it would in a turn.
import assert from 'node:assert/strict'

import { z } from 'zod'

/** The tools the role mcp's production profile lists, in mcp-nest's tools/list shape. */
export async function productionMcpTools() {
  await import('reflect-metadata')
  const { default: mcpNest } = await import('@rekog/mcp-nest')
  const { McpToolsController } = await import('../../mcp/dist/site-info/mcp-tools.controller.js')
  const tools = Object.getOwnPropertyNames(McpToolsController.prototype).flatMap((name) => {
    const meta = Reflect.getMetadata(
      mcpNest.MCP_TOOL_METADATA_KEY,
      McpToolsController.prototype[name],
    )
    return meta
      ? [
          {
            name: meta.name,
            description: meta.description,
            annotations: meta.annotations,
            inputSchema: z.toJSONSchema(meta.parameters, { target: 'draft-2020-12', io: 'input' }),
          },
        ]
      : []
  })
  assert.ok(
    tools.some((tool) => tool.name === 'site_info'),
    'The production MCP profile lost site_info',
  )
  return tools
}
