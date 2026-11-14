import { Inject } from '@nestjs/common'
import { Ctx, Payload } from '@nestjs/microservices'
import { McpController, Tool, ToolScopes, type McpContext } from '@rekog/mcp-nest'
import {
  docCreateArgumentsSchema,
  docFinishArgumentsSchema,
  docReadArgumentsSchema,
  docSectionMoveArgumentsSchema,
  docSectionRemoveArgumentsSchema,
  docSectionWriteArgumentsSchema,
  type DocCreateArguments,
  type DocSectionWriteArguments,
} from '@repo/domain'

import { MCP_REQUEST_ACCESS, type McpRequest } from '../access/mcp-request.ts'
import { mcpCanonicalJson } from '../common/canonical-json.ts'
import type { McpDocsService } from './docs-service.ts'
import type { McpPagesAnswer } from './pages-service.ts'
import { MCP_DOCS } from './pages.tokens.ts'

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
const writes = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

/**
 * The documents of a workspace (docs/plan/69-pages.md, Ст20, Ст21): the family `docs`, declared to
 * every turn (`@ToolScopes(['docs'])`). The model sees `raditi_doc_create` and the rest. The order
 * the descriptions teach — the skeleton first, a section a call, findings into the document, the
 * sources last, a check before the finish — is the one of the brief.
 */
@McpController()
export class McpDocsController {
  constructor(@Inject(MCP_DOCS) private readonly docs: McpDocsService) {}

  #scope(context: McpContext) {
    return context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]
  }

  @ToolScopes(['docs'])
  @Tool({
    name: 'doc_create',
    description:
      'Start a long document for the client — an audit, a plan of work, a summary, an instruction — as its skeleton: the title and every section by an id with its intent in one line (e.g. "Итог: три главные причины медленной загрузки"). Call it first, before searching or reading anything, so the client sees the document appear. The last section is «Источники». Write in the language of the client, Russian and «вы» by default. The client sees the title and the intents at once: never a secret, a value of a variable or data of people in them.',
    parameters: docCreateArgumentsSchema,
    annotations: writes,
  })
  async create(@Payload() args: DocCreateArguments, @Ctx() context: McpContext) {
    const scope = this.#scope(context)
    return scope ? answerOf(await this.docs.create(scope, args)) : unauthorized
  }

  @ToolScopes(['docs'])
  @Tool({
    name: 'doc_section_write',
    description:
      'Write one section of a document by its id: its heading and its Markdown, headings inside it from ### down, lists only where the content is a list, tables for comparisons, no raw HTML. It replaces the section whole; with after it adds a new section after that id (null — first). One section a call: never send the whole document, never rebuild it from memory. Put findings here, not in the chat. Never a secret, a value of a variable, a key, or a dump or a whole table of a database; data of people (form entries, leads, orders, customers) only when the client asks for them. The client sees the text once this turn ends and the platform checked it.',
    parameters: docSectionWriteArgumentsSchema,
    annotations: writes,
  })
  async write(@Payload() args: DocSectionWriteArguments, @Ctx() context: McpContext) {
    const scope = this.#scope(context)
    return scope ? answerOf(await this.docs.write(scope, args)) : unauthorized
  }

  @ToolScopes(['docs'])
  @Tool({
    name: 'doc_section_remove',
    description: 'Remove a section of a document by its id.',
    parameters: docSectionRemoveArgumentsSchema,
    annotations: { ...writes, destructiveHint: true },
  })
  async remove(@Payload() args: { docId: string; id: string }, @Ctx() context: McpContext) {
    const scope = this.#scope(context)
    return scope ? answerOf(await this.docs.remove(scope, args)) : unauthorized
  }

  @ToolScopes(['docs'])
  @Tool({
    name: 'doc_section_move',
    description: 'Put a section of a document after another one by their ids (after null — first).',
    parameters: docSectionMoveArgumentsSchema,
    annotations: writes,
  })
  async move(
    @Payload() args: { docId: string; id: string; after: string | null },
    @Ctx() context: McpContext,
  ) {
    const scope = this.#scope(context)
    return scope ? answerOf(await this.docs.move(scope, args)) : unauthorized
  }

  @ToolScopes(['docs'])
  @Tool({
    name: 'doc_read',
    description:
      'Read a document: every section with its id, state (pending or written), heading and text. Before doc_finish read it whole: check facts and figures against the sources, count the arithmetic again, make sure no placeholder is left.',
    parameters: docReadArgumentsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  })
  async read(@Payload() args: { docId: string }, @Ctx() context: McpContext) {
    const scope = this.#scope(context)
    return scope ? answerOf(await this.docs.read(scope, args)) : unauthorized
  }

  @ToolScopes(['docs'])
  @Tool({
    name: 'doc_finish',
    description:
      'Finish a document: refused while a section is a placeholder. The version is made when this turn ends. Then tell the client in one or two lines what came of it — never retell the document.',
    parameters: docFinishArgumentsSchema,
    annotations: writes,
  })
  async finish(@Payload() args: { docId: string }, @Ctx() context: McpContext) {
    const scope = this.#scope(context)
    return scope ? answerOf(await this.docs.finish(scope, args)) : unauthorized
  }
}
