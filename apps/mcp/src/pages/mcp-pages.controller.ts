import { Inject } from '@nestjs/common'
import { Ctx, Payload } from '@nestjs/microservices'
import { McpController, Tool, ToolScopes, type McpContext } from '@rekog/mcp-nest'

import { MCP_REQUEST_ACCESS, type McpRequest } from '../access/mcp-request.ts'
import { mcpCanonicalJson } from '../common/canonical-json.ts'
import {
  pageDeleteToolArgumentsSchema,
  pageEditToolArgumentsSchema,
  pageFileDeleteToolArgumentsSchema,
  pageFilePutToolArgumentsSchema,
  pageFilesToolArgumentsSchema,
  pageListToolArgumentsSchema,
  pagePublishToolArgumentsSchema,
  pageReadToolArgumentsSchema,
  pageRestoreToolArgumentsSchema,
  pageTreeToolArgumentsSchema,
  pageUpdateToolArgumentsSchema,
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

const reads = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}
const writes = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

const scopeOf = (context: McpContext) => context.getRawRequest<McpRequest>()?.[MCP_REQUEST_ACCESS]

/**
 * The pages of a workspace (docs/plan/69-pages.md, Ст20; docs/plan/73-pages-sites.md, §6): the
 * reads — the family `pages` — declared to every turn where the pages are configured, the
 * publication and every change — `pages_changes` — only to a turn its client watches: a pass of a
 * scheduled run without its client changes nothing its visitors see (`@ToolScopes`,
 * mcpToolFamiliesOf; docs/plan/82-scheduled-tasks.md, Зп28, Зп32). A site is a host with pages at
 * paths. Reading is at once; a publication and every change are applied when the turn ends. Taking
 * a page down, its password and emptying the trash are the client's, in the cabinet: no tool for
 * them.
 */
@McpController()
export class McpPagesController {
  constructor(@Inject(MCP_PAGES) private readonly pages: McpPagesService) {}

  @ToolScopes(['pages_changes'])
  @Tool({
    name: 'page_publish',
    description:
      'Publish a web page for the client and get its address now: give the client that address in your answer. Either file — a self-contained .html or .md you write to the outbox folder in this turn (styles and scripts inside, pictures as data: or public https addresses), with title — or docId of a finished document. Without pageId and treeId the file is a new site of one home page; with treeId and path it is a new page of that site at that address (its parent path must have a page, e.g. /uslugi before /uslugi/remont; a site made in this turn counts); with pageId and expectedVersion it is the next version at the same address. Link the pages of a site to each other from the root: href="/uslugi". The page runs in a sandbox without the origin of its site: localStorage, sessionStorage, cookies, caches, indexedDB and service workers throw an error there, so a script wraps each use of them in try and works without them. The page goes live when this turn ends. Publish when the client asks for a page, a site or a link, or when a page is the plain result of the request. Never put a secret, a value of a variable, a key, or a dump or a whole table of a database on a page. Data of people (form entries, leads, orders, customers) only when the client asks for it, and then advise them to set a password in the cabinet.',
    parameters: pagePublishToolArgumentsSchema,
    annotations: { ...writes, idempotentHint: true },
  })
  async publish(@Payload() args: PagePublishToolArguments, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.publish(scope, args))
  }

  @ToolScopes(['pages'])
  @Tool({
    name: 'page_list',
    description:
      'The sites of pages of this workspace: treeId, the title and address of the home page (homePageId), its state and version, whether a password is set, how many pages; after them the sites in the trash, marked deleted — page_restore of their homePageId returns the whole site. Look here before page_publish: update a site instead of making a new one. A workspace may have only as many sites as its tariff allows.',
    parameters: pageListToolArgumentsSchema,
    annotations: reads,
  })
  async list(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.list(scope, args))
  }

  @ToolScopes(['pages'])
  @Tool({
    name: 'page_tree',
    description:
      'The pages of one site with their paths, parents, titles, versions and addresses, and the pages of it in the trash.',
    parameters: pageTreeToolArgumentsSchema,
    annotations: reads,
  })
  async tree(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.tree(scope, args))
  }

  @ToolScopes(['pages'])
  @Tool({
    name: 'page_read',
    description:
      'The text of a page as it is now — the Markdown it was drawn from, or its HTML — with its version, a piece at a time (truncated and nextOffset). Read a page before page_edit.',
    parameters: pageReadToolArgumentsSchema,
    annotations: reads,
  })
  async read(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.read(scope, args))
  }

  @ToolScopes(['pages_changes'])
  @Tool({
    name: 'page_edit',
    description:
      'Change the text of a page by search and replace, at the version page_read gave you: each old must be found exactly once (or set all), checked now against the page as it is. Put all the edits of one page into one call. The new version goes live at the same address when this turn ends; a version or an edit of this turn before it counts as yours; if someone else changed the page meanwhile, nothing is changed and the client is told. Only when the author of this chat is an owner or an administrator of the workspace.',
    parameters: pageEditToolArgumentsSchema,
    annotations: writes,
  })
  async edit(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.edit(scope, args))
  }

  @ToolScopes(['pages_changes'])
  @Tool({
    name: 'page_update',
    description:
      'Rename a page, change the last part of its address, put it under another page of its site or change its order, when this turn ends; after page_publish of the page in this turn give the version it answered. The former addresses of it and of the pages below it keep leading to them. The home page keeps its address. Only when the author of this chat is an owner or an administrator of the workspace.',
    parameters: pageUpdateToolArgumentsSchema,
    annotations: writes,
  })
  async update(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.update(scope, args))
  }

  @ToolScopes(['pages_changes'])
  @Tool({
    name: 'page_delete',
    description:
      'Move pages to the trash of «Страницы» when this turn ends — only when the client asked in this chat, in their own words, to delete them. A page with pages below it needs withChildren; a home page takes its whole site. If pages were added below it before the turn ends, nothing is deleted and the client is told. At most 20 pages a turn; the client can return them for 30 days. Only when the author of this chat is an owner or an administrator of the workspace.',
    parameters: pageDeleteToolArgumentsSchema,
    annotations: { ...writes, destructiveHint: true },
  })
  async delete(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.delete(scope, args))
  }

  @ToolScopes(['pages_changes'])
  @Tool({
    name: 'page_file_put',
    description:
      'Put a file of the outbox — CSS, a script, a picture, a font or a PDF, no HTML — as a shared file of a site at /_files/…, when this turn ends; its pages load it from their own host, e.g. <link rel="stylesheet" href="/_files/style.css">. The same path again replaces it. At most 5 MB a file and 50 MB a site.',
    parameters: pageFilePutToolArgumentsSchema,
    annotations: { ...writes, idempotentHint: true },
  })
  async putFile(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.putFile(scope, args))
  }

  @ToolScopes(['pages'])
  @Tool({
    name: 'page_files',
    description:
      'The shared files of a site — CSS, scripts, pictures, fonts, PDFs at /_files/… — with their types, sizes and addresses.',
    parameters: pageFilesToolArgumentsSchema,
    annotations: reads,
  })
  async files(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.files(scope, args))
  }

  @ToolScopes(['pages_changes'])
  @Tool({
    name: 'page_file_delete',
    description:
      'Delete a shared file of a site when this turn ends — only when the client asked in this chat, in their own words, to delete it; a page that loads it shows without it. It does not go to the trash. Only when the author of this chat is an owner or an administrator of the workspace.',
    parameters: pageFileDeleteToolArgumentsSchema,
    annotations: { ...writes, destructiveHint: true },
  })
  async deleteFile(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.deleteFile(scope, args))
  }

  @ToolScopes(['pages_changes'])
  @Tool({
    name: 'page_restore',
    description:
      'Return pages from the trash, with the pages deleted with them, when this turn ends. Only when the author of this chat is an owner or an administrator of the workspace.',
    parameters: pageRestoreToolArgumentsSchema,
    annotations: writes,
  })
  async restore(@Payload() args: unknown, @Ctx() context: McpContext) {
    const scope = scopeOf(context)
    if (!scope) return unauthorized
    return answerOf(await this.pages.restore(scope, args))
  }
}
