import type { PageChange } from '@repo/db'
import {
  editPageText,
  isDomainError,
  pageAddressUrl,
  pageDeleteArgumentsSchema,
  pageEditArgumentsSchema,
  pageFilePutArgumentsSchema,
  pageListArgumentsSchema,
  pagePublishArgumentsSchema,
  pageReadArgumentsSchema,
  pageRestoreArgumentsSchema,
  pageTreeArgumentsSchema,
  pageUpdateArgumentsSchema,
  type PagesAddress,
} from '@repo/domain'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import type { PagePublishToolArguments } from './pages-arguments.ts'

/**
 * The pages of a workspace for the agent (docs/plan/69-pages.md, Ст6, Ст7, Ст16, Ст20;
 * docs/plan/73-pages-sites.md, Дер11–Дер28): sites of pages, each a host with pages at paths.
 * `page_list`, `page_tree` and `page_read` answer at once from the database; `page_publish`
 * reserves an address at once, and it and `page_edit`, `page_update`, `page_delete` and
 * `page_restore` are applied by core when the turn ends — only core knows the values of the client
 * and the keys of the turn. A page belongs to the workspace, not to the chat that made it (Дер8).
 * Who the caller is comes from the admitted turn, never from the arguments.
 */

/** A page as the store lists it: a node of its site. */
export interface McpListedPage {
  id: string
  slug: string
  treeId: string
  parentId: string | null
  path: string
  position: number
  title: string
  kind: string
  state: string
  currentVersion: number
  hasPassword: boolean
  /** In the trash: the agent does not see it, but page_restore names it. */
  deletedAt: Date | null
  updatedAt: Date
}

export interface McpPagesStore {
  reserve(input: {
    workspaceId: string
    taskId: string
    turnNo: number
    title: string
    target: { fileName: string } | { documentId: string }
    pageId?: string
    expectedVersion?: number
    place?: { treeId: string; path: string }
  }): Promise<{ pageId: string; slug: string; path: string; treeId: string; version: number }>
  /** The title of a document of the workspace; throws DOC_NOT_FOUND. */
  documentTitle(workspaceId: string, documentId: string): Promise<string>
  list(workspaceId: string): Promise<McpListedPage[]>
  read(input: { workspaceId: string; pageId: string }): Promise<{
    pageId: string
    kind: string
    version: number
    documentId: string | null
    format: 'markdown' | 'html' | 'none'
    text: string
  }>
  putFile(input: {
    workspaceId: string
    taskId: string
    turnNo: number
    treeId: string
    fileName: string
    path: string
  }): Promise<{ reservationId: string; slug: string; path: string }>
  files(input: {
    workspaceId: string
    treeId: string
  }): Promise<{ path: string; type: string; sizeBytes: number }[]>
  change(input: {
    workspaceId: string
    taskId: string
    turnNo: number
    change: PageChange
  }): Promise<{ reservationId: string; pageId: string; pages: number }>
}

export type McpPagesAnswer =
  { ok: true; value: unknown } | { ok: false; code: string; message: string }

const refusal = (error: unknown): McpPagesAnswer => {
  if (isDomainError(error)) return { ok: false, code: error.code, message: error.message }
  throw error
}

const badRequest = (message: string): McpPagesAnswer => ({
  ok: false,
  code: 'BAD_REQUEST',
  message,
})

const later = 'when this turn ends'

export class McpPagesService {
  readonly #store: McpPagesStore
  readonly #address: PagesAddress

  constructor(deps: { store: McpPagesStore; address: PagesAddress }) {
    this.#store = deps.store
    this.#address = deps.address
  }

  #url(page: { slug: string; path: string }) {
    return pageAddressUrl(page.slug, this.#address, page.path)
  }

  async publish(scope: McpTurnAccess, args: PagePublishToolArguments): Promise<McpPagesAnswer> {
    const parsed = pagePublishArgumentsSchema.safeParse(args)
    if (!parsed.success)
      return badRequest(
        'Give either file with title (and pageId for a new version, or treeId with path for a new page of a site) or docId',
      )
    try {
      const input = parsed.data
      const target = 'file' in input ? { fileName: input.file } : { documentId: input.docId }
      const title =
        'file' in input
          ? input.title
          : (input.title ?? (await this.#store.documentTitle(scope.workspaceId, input.docId)))
      const page = await this.#store.reserve({
        workspaceId: scope.workspaceId,
        taskId: scope.taskId,
        turnNo: scope.turn,
        title,
        target,
        ...('pageId' in input && input.pageId ? { pageId: input.pageId } : {}),
        ...('expectedVersion' in input && input.expectedVersion !== undefined
          ? { expectedVersion: input.expectedVersion }
          : {}),
        ...('treeId' in input && input.treeId && input.path
          ? { place: { treeId: input.treeId, path: input.path } }
          : {}),
      })
      return {
        ok: true,
        value: {
          pageId: page.pageId,
          treeId: page.treeId,
          path: page.path,
          url: this.#url(page),
          version: page.version,
          live: later,
          warnings:
            'file' in input
              ? [
                  `The page is made from the file ${input.file} of the outbox when this turn ends: write it there in this turn, self-contained. Link the pages of its site from the root: href="/path".`,
                ]
              : ['The page is made from the finished version of the document when this turn ends.'],
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }

  /**
   * The sites of the workspace, newest first: their home pages, and after them the sites in the
   * trash (`deleted`) — page_restore of the home page returns the whole site.
   */
  async list(scope: McpTurnAccess, args: unknown = {}): Promise<McpPagesAnswer> {
    const parsed = pageListArgumentsSchema.safeParse(args ?? {})
    if (!parsed.success) return badRequest('query, offset and limit only')
    try {
      const all = await this.#store.list(scope.workspaceId)
      const pages = all.filter((page) => page.deletedAt === null)
      const query = parsed.data.query?.trim().toLocaleLowerCase('ru') ?? ''
      const homes = all
        .filter((page) => page.parentId === null)
        .filter((page) => page.title.toLocaleLowerCase('ru').includes(query))
        .sort((a, b) => Number(a.deletedAt !== null) - Number(b.deletedAt !== null))
      const offset = parsed.data.offset ?? 0
      const limit = parsed.data.limit ?? 50
      const shown = homes.slice(offset, offset + limit)
      return {
        ok: true,
        value: {
          sites: shown.map((home) => ({
            treeId: home.treeId,
            homePageId: home.id,
            title: home.title,
            url: this.#url(home),
            kind: home.kind,
            state: home.state,
            version: home.currentVersion,
            password: home.hasPassword,
            ...(home.deletedAt === null
              ? { pages: pages.filter((page) => page.treeId === home.treeId).length }
              : {
                  deleted: true,
                  pages: all.filter(
                    (page) =>
                      page.treeId === home.treeId &&
                      page.deletedAt?.getTime() === home.deletedAt?.getTime(),
                  ).length,
                }),
          })),
          total: homes.length,
          ...(offset + limit < homes.length ? { nextOffset: offset + limit } : {}),
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }

  /** The pages of one site with their paths, by their places (Дер12). */
  async tree(scope: McpTurnAccess, args: unknown): Promise<McpPagesAnswer> {
    const parsed = pageTreeArgumentsSchema.safeParse(args)
    if (!parsed.success) return badRequest('Give treeId of page_list')
    try {
      const all = await this.#store.list(scope.workspaceId)
      const pages = all.filter((page) => page.treeId === parsed.data.treeId)
      if (pages.length === 0)
        return { ok: false, code: 'PAGE_NOT_FOUND', message: 'No such site in this workspace' }
      const live = pages
        .filter((page) => page.deletedAt === null)
        .sort((a, b) => a.path.localeCompare(b.path) || a.position - b.position)
      return {
        ok: true,
        value: {
          treeId: parsed.data.treeId,
          pages: live.map((page) => ({
            pageId: page.id,
            parentId: page.parentId,
            path: page.path,
            position: page.position,
            title: page.title,
            url: this.#url(page),
            kind: page.kind,
            state: page.state,
            version: page.currentVersion,
          })),
          trash: pages
            .filter((page) => page.deletedAt !== null)
            .map((page) => ({ pageId: page.id, path: page.path, title: page.title })),
          files: (
            await this.#store.files({ workspaceId: scope.workspaceId, treeId: parsed.data.treeId })
          ).map((file) => ({ path: file.path, type: file.type, sizeBytes: file.sizeBytes })),
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }

  /** The text of a page — its Markdown, or the HTML it serves — a piece at a time (Дер26). */
  async read(scope: McpTurnAccess, args: unknown): Promise<McpPagesAnswer> {
    const parsed = pageReadArgumentsSchema.safeParse(args)
    if (!parsed.success) return badRequest('Give pageId of page_tree')
    try {
      const page = await this.#store.read({
        workspaceId: scope.workspaceId,
        pageId: parsed.data.pageId,
      })
      if (page.documentId !== null)
        return {
          ok: true,
          value: {
            pageId: page.pageId,
            version: page.version,
            docId: page.documentId,
            warnings: ['A page of a document: read and change it by doc_read and the doc_* tools.'],
          },
        }
      const offset = parsed.data.offset ?? 0
      const limit = parsed.data.limit ?? 32_768
      const chars = [...page.text]
      const piece = chars.slice(offset, offset + limit).join('')
      const truncated = offset + limit < chars.length
      return {
        ok: true,
        value: {
          pageId: page.pageId,
          kind: page.kind,
          version: page.version,
          format: page.format,
          text: piece,
          truncated,
          ...(truncated ? { nextOffset: offset + limit } : {}),
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }

  /** A file of the outbox as a shared file of a site, at the end of the turn (Дер34). */
  async putFile(scope: McpTurnAccess, args: unknown): Promise<McpPagesAnswer> {
    const parsed = pageFilePutArgumentsSchema.safeParse(args)
    if (!parsed.success)
      return badRequest(
        'Give treeId, a file of the outbox and its path: /_files/<name>.<css|js|svg|png|jpg|webp|gif|avif|ico|woff2|woff|pdf>',
      )
    try {
      const reserved = await this.#store.putFile({
        workspaceId: scope.workspaceId,
        taskId: scope.taskId,
        turnNo: scope.turn,
        treeId: parsed.data.treeId,
        fileName: parsed.data.file,
        path: parsed.data.path,
      })
      return {
        ok: true,
        value: {
          url: this.#url({ slug: reserved.slug, path: '/' }).replace(/\/$/, '') + reserved.path,
          path: reserved.path,
          live: later,
          warnings: [
            `Load it in the pages of the site by its path from the root, e.g. <link rel="stylesheet" href="${reserved.path}">.`,
          ],
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }

  async edit(scope: McpTurnAccess, args: unknown): Promise<McpPagesAnswer> {
    const parsed = pageEditArgumentsSchema.safeParse(args)
    if (!parsed.success) return badRequest('Give pageId, expectedVersion and edits of old and new')
    // Each `old` against the text the page shows now: a miss is the agent's to fix in this turn,
    // not a refusal the client reads at its end.
    try {
      const page = await this.#store.read({
        workspaceId: scope.workspaceId,
        pageId: parsed.data.pageId,
      })
      if (page.format !== 'none') {
        const edited = editPageText(page.text, parsed.data.edits)
        if (!edited.ok)
          return {
            ok: false,
            code: 'PAGE_EDIT_UNMATCHED',
            message:
              edited.found === 0
                ? `edits[${edited.at}].old is not in the page as it is now: read it again with page_read`
                : `edits[${edited.at}].old is found ${edited.found} times: give more text around it, or set all`,
          }
      }
    } catch (error) {
      return refusal(error)
    }
    return this.#change(scope, [{ kind: 'edit', ...parsed.data }])
  }

  async update(scope: McpTurnAccess, args: unknown): Promise<McpPagesAnswer> {
    const parsed = pageUpdateArgumentsSchema.safeParse(args)
    if (!parsed.success)
      return badRequest(
        'Give pageId, expectedVersion and what changes: title, segment, parentId or position',
      )
    return this.#change(scope, [{ kind: 'update', ...parsed.data }])
  }

  async delete(scope: McpTurnAccess, args: unknown): Promise<McpPagesAnswer> {
    const parsed = pageDeleteArgumentsSchema.safeParse(args)
    if (!parsed.success)
      return badRequest(
        'Delete only what the client asked to delete in this chat: pageIds and confirmedByClient: true',
      )
    const withChildren = parsed.data.withChildren ?? false
    let pageIds = [...new Set(parsed.data.pageIds)]
    if (withChildren) {
      // A page below another one asked goes with it: counted once, never refused as gone.
      try {
        const all = await this.#store.list(scope.workspaceId)
        const byId = new Map(all.map((page) => [page.id, page]))
        const asked = pageIds.map((id) => byId.get(id)).filter((page) => page !== undefined)
        pageIds = pageIds.filter((id) => {
          const page = byId.get(id)
          return !(
            page &&
            asked.some(
              (other) =>
                other.id !== page.id &&
                other.treeId === page.treeId &&
                (other.path === '/' || page.path.startsWith(`${other.path}/`)),
            )
          )
        })
      } catch (error) {
        return refusal(error)
      }
    }
    return this.#change(
      scope,
      pageIds.map((pageId) => ({ kind: 'delete' as const, pageId, withChildren })),
    )
  }

  async restore(scope: McpTurnAccess, args: unknown): Promise<McpPagesAnswer> {
    const parsed = pageRestoreArgumentsSchema.safeParse(args)
    if (!parsed.success) return badRequest('Give pageIds of the trash of page_tree')
    return this.#change(
      scope,
      parsed.data.pageIds.map((pageId) => ({ kind: 'restore' as const, pageId })),
    )
  }

  /** Changes reserved one by one: the first refusal stops the call, what came before stays. */
  async #change(scope: McpTurnAccess, changes: PageChange[]): Promise<McpPagesAnswer> {
    const reserved: { pageId: string; pages: number }[] = []
    try {
      for (const change of changes) {
        const done = await this.#store.change({
          workspaceId: scope.workspaceId,
          taskId: scope.taskId,
          turnNo: scope.turn,
          change,
        })
        reserved.push({ pageId: done.pageId, pages: done.pages })
      }
      return { ok: true, value: { reserved, live: later } }
    } catch (error) {
      if (reserved.length === 0) return refusal(error)
      const refused = refusal(error)
      return {
        ok: true,
        value: { reserved, live: later, refused: refused.ok ? null : refused },
      }
    }
  }
}
