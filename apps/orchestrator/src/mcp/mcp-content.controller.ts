import { Inject } from '@nestjs/common'
import { Ctx, Payload } from '@nestjs/microservices'
import { McpController, Tool, ToolScopes, type McpContext } from '@rekog/mcp-nest'
import { isDomainError } from '@repo/domain'

import { MCP_REQUEST_ACCESS } from './mcp-access.ts'
import type { McpRequest } from './mcp-auth.guard.ts'
import {
  dbSchemaArgumentsSchema,
  MCP_CONTENT,
  type DbSchemaArguments,
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
  // The preview of the dialog (docs/plan/53-chat-preview-release.md, Р24): not built yet (a
  // retry later can pass), not taking content in this turn, or named in a value.
  'CONTENT_PREVIEW_NOT_READY',
  'CONTENT_PREVIEW_UNAVAILABLE',
  'CONTENT_PREVIEW_ORIGIN',
  'CONTENT_CREDENTIAL_REFUSED',
  // The objects of a plan (docs/plan/53, «Операции БД и миграции»): what this site does not
  // carry, a setting outside the list or a value it does not take, a table not where the call
  // expects it, the id of a new record named in a value.
  'DB_OPERATION_NOT_ALLOWED',
  'DB_SETTING_NOT_ALLOWED',
  'DB_SETTING_INVALID',
  'DB_SCHEMA_INVALID',
  'DB_SCHEMA_CONFLICT',
  'CONTENT_CREATED_ID',
])

@McpController()
export class McpContentController {
  constructor(@Inject(MCP_CONTENT) private readonly content: McpContentService) {}

  @ToolScopes(['content'])
  @Tool({
    name: 'wp_rest',
    description:
      "Read or update title, content and excerpt of one post or page of this dialog's preview (/wp/v2/posts/ID, /wp/v2/pages/ID). Where site_info database.operations allows: create a page or post (POST /wp/v2/pages or /wp/v2/posts with title, content, excerpt, slug of Latin letters, digits and hyphens, status publish or draft); read the settings a release carries (GET /wp/v2/settings) and change one of them (POST /wp/v2/settings with one setting). Links inside content use the site's own address (site_info siteUrl), never the preview's, and name a new page by its address, never by its ID. Preserve opaque contact markers. POST requires an idempotency key; a repeated key returns the first result, so retry an error with a new key.",
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

  @ToolScopes(['schema'])
  @Tool({
    name: 'db_schema',
    description:
      "Read, create or extend a table of the platform in this dialog's preview: the only way a site's database gets structure a release carries. GET reads the table; POST create makes it from columns (types string with length, text, long_text, integer, big_integer, unsigned_big_integer, boolean, decimal with precision and scale, date, datetime; nullable; default as {value} or {now: true} for datetime) and indexes; POST add appends columns that are nullable or have a default and indexes that are not unique. An id column is implicit. How code names the table is in the platform rules of this site. Never create tables in code. Requires an idempotency key; a repeated key returns the first result.",
    parameters: dbSchemaArgumentsSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  dbSchema(@Payload() args: DbSchemaArguments, @Ctx() context: McpContext) {
    return this.#call(context, (scope) => this.content.dbSchema(scope, args))
  }

  @ToolScopes(['content'])
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
