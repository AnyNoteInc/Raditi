import { Inject } from '@nestjs/common'
import { Ctx, Payload } from '@nestjs/microservices'
import { McpController, Tool, type McpContext } from '@rekog/mcp-nest'
import { isDomainError } from '@repo/domain'

import { MCP_REQUEST_ACCESS } from './mcp-access.ts'
import type { McpRequest } from './mcp-auth.guard.ts'
import {
  MCP_CONTENT,
  type McpContentService,
  restoreArgumentsSchema,
  wpRestArgumentsSchema,
  type RestoreArguments,
  type WpRestArguments,
} from './mcp-content.ts'
import { mcpCanonicalJson } from './mcp-journal.ts'

/** Fixed, content-free refusals that tell the agent whether a retry can help. */
const agentCodes = new Set([
  'CONTENT_PRIVACY_LIMIT',
  'CONTENT_PRIVACY_UNAVAILABLE',
  'CONTENT_PRIVACY_CONTEXT',
  'CONTENT_TOO_LARGE',
  'CONTENT_OBJECT_UNAVAILABLE',
  'MCP_APPROVAL_REQUIRED',
  'MCP_CALL_IN_FLIGHT',
])

@McpController()
export class McpContentController {
  constructor(@Inject(MCP_CONTENT) private readonly content: McpContentService) {}

  @Tool({
    name: 'wp_rest',
    description:
      'Read or update title, content and excerpt of one published post or page. Routes: /wp/v2/posts/ID and /wp/v2/pages/ID. Preserve opaque contact markers. POST requires an idempotency key; a repeated key returns the first result, so retry an error with a new key.',
    parameters: wpRestArgumentsSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  wpRest(@Payload() args: WpRestArguments, @Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.content.wpRest(scope, args))
  }

  @Tool({
    name: 'restore',
    description:
      'Restore a snapshot made by an edit of this turn. A later edit of the object prevents restoration. Requires an idempotency key; a repeated key returns the first result, so retry an error with a new key.',
    parameters: restoreArgumentsSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  restore(@Payload() args: RestoreArguments, @Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.content.restore(scope, args))
  }

  async #call(
    context: McpContext,
    run: (
      scope: NonNullable<McpRequest[typeof MCP_REQUEST_ACCESS]>,
    ) => ReturnType<McpContentService['restore']>,
  ) {
    const scope = context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]
    if (!scope)
      return { isError: true, content: [{ type: 'text', text: 'MCP authorization is required' }] }
    try {
      const outcome = await run(scope)
      return {
        ...(outcome.result === 'ok' ? {} : { isError: true }),
        content: [{ type: 'text', text: mcpCanonicalJson(outcome.response) }],
      }
    } catch (error) {
      const code =
        isDomainError(error) && agentCodes.has(error.code) ? error.code : 'CONTENT_CALL_REJECTED'
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ code }) }] }
    }
  }
}
