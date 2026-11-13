import { Inject } from '@nestjs/common'
import { Ctx, Payload } from '@nestjs/microservices'
import { McpController, Tool, ToolScopes, type McpContext } from '@rekog/mcp-nest'

import { MCP_REQUEST_ACCESS, type McpRequest } from '../access/mcp-request.ts'
import { mcpCanonicalJson } from '../common/canonical-json.ts'
import {
  pageListArgumentsSchema,
  pagePublishToolArgumentsSchema,
  type PagePublishToolArguments,
} from './pages-arguments.ts'
import type { McpPagesAnswer, McpPagesService } from './pages-service.ts'
import { MCP_PAGES } from './pages.tokens.ts'

const answerOf = (answer: McpPagesAnswer) =>
  answer.ok
    ? { content: [{ type: 'text', text: mcpCanonicalJson(answer.value) }] }
    : {
        isError: true,
        content: [
          { type: 'text', text: JSON.stringify({ code: answer.code, message: answer.message }) },
        ],
      }

const unauthorized = {
  isError: true,
  content: [{ type: 'text', text: 'MCP authorization is required' }],
}

/**
 * The pages of a workspace (docs/plan/69-pages.md, Ст20): the family `pages`, declared to every
 * turn where the pages are configured (`@ToolScopes(['pages'])`, mcpToolFamiliesOf). The model
 * sees `raditi_page_publish` and `raditi_page_list`. Taking a page down and its password are the
 * client's, in the cabinet: no tool for them.
 */
@McpController()
export class McpPagesController {
  constructor(@Inject(MCP_PAGES) private readonly pages: McpPagesService) {}

  @ToolScopes(['pages'])
  @Tool({
    name: 'page_publish',
    description:
      'Publish a web page for the client and get its address now: give the client that address in your answer. Either file — a self-contained .html or .md you write to the outbox folder in this turn (styles and scripts inside, pictures as data: or public https addresses), with title; add pageId of page_list for a new version at the same address — or docId of a finished document. The page goes live when this turn ends. Publish a file when the client asks for a page or a link, or when a page is the plain result of the request; publish a document only when the client asks for its link. Never put a secret, a value of a variable, a key, or a dump or a whole table of a database on a page. Data of people (form entries, leads, orders, customers) only when the client asks for it, and then advise them to set a password in the cabinet.',
    parameters: pagePublishToolArgumentsSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async publish(@Payload() args: PagePublishToolArguments, @Ctx() context: McpContext) {
    const scope = context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]
    if (!scope) return unauthorized
    return answerOf(await this.pages.publish(scope, args))
  }

  @ToolScopes(['pages'])
  @Tool({
    name: 'page_list',
    description:
      'The pages of this workspace, from every chat: pageId, title, address, version, state and whether a password is set. Look here before page_publish to update a page instead of making a new one.',
    parameters: pageListArgumentsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async list(@Ctx() context: McpContext) {
    const scope = context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]
    if (!scope) return unauthorized
    return answerOf(await this.pages.list(scope))
  }
}
