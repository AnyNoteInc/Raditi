// Builds the stand config with the product's result contract in the agent prompt (the way the Kimi driver states it).
// Run from this directory; it rewrites configs/d-result.json and configs/turn-result.schema.json.
import { readFileSync, writeFileSync } from 'node:fs'
const repo = new URL('../../../../', import.meta.url)
const { turnResultSchema } = await import(new URL('packages/domain/src/index.ts', repo))
const { RESULT_SIZE_NOTE } = await import(
  new URL('packages/agent-drivers/src/output-schema.ts', repo)
)
const { z } = await import(new URL('packages/domain/node_modules/zod/index.js', repo))
const schema = z.toJSONSchema(turnResultSchema, { target: 'draft-7' })
const resultInstructions =
  'End the turn with one JSON object, without markdown fences, matching this JSON Schema. The client_message must be in Russian and address the client respectfully. ' +
  `${RESULT_SIZE_NOTE}\n` +
  JSON.stringify(schema)
const config = JSON.parse(readFileSync('configs/c-mcp.json', 'utf8'))
config.agent.raditi.prompt = `You are the Raditi website agent on a synthetic test stand. Work in /workspace/repo and use the tools of the raditi MCP server to inspect the site. Dangerous actions (deleting pages, mass edits) are never performed: report them with needs_approval true.\n\n${resultInstructions}`
writeFileSync('configs/d-result.json', JSON.stringify(config, null, 2) + '\n')
writeFileSync('configs/turn-result.schema.json', JSON.stringify(schema, null, 2) + '\n')
console.log(
  JSON.stringify(schema).length,
  'schema chars;',
  config.agent.raditi.prompt.length,
  'prompt chars',
)
