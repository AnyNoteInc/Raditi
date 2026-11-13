import {
  isDomainError,
  pageAddressUrl,
  pagePublishArgumentsSchema,
  type PagesAddress,
} from '@repo/domain'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import type { PagePublishToolArguments } from './pages-arguments.ts'

/**
 * The pages of a workspace for the agent (docs/plan/69-pages.md, Ст6, Ст7, Ст16, Ст20):
 * `page_publish` reserves the address at once and the end of the turn makes the version — from
 * the file of the outbox, or from the finished document; `page_list` names every page of the
 * workspace, so a page is updated rather than made again. Who the caller is comes from the
 * admitted turn, never from the arguments.
 */

export interface McpPagesStore {
  reserve(input: {
    workspaceId: string
    taskId: string
    turnNo: number
    title: string
    target: { fileName: string } | { documentId: string }
    pageId?: string
  }): Promise<{ pageId: string; slug: string; version: number }>
  /** The title of a document of the workspace; throws DOC_NOT_FOUND. */
  documentTitle(workspaceId: string, documentId: string): Promise<string>
  list(workspaceId: string): Promise<
    {
      id: string
      slug: string
      title: string
      kind: string
      state: string
      currentVersion: number
      taskId: string | null
      hasPassword: boolean
    }[]
  >
}

export type McpPagesAnswer =
  { ok: true; value: unknown } | { ok: false; code: string; message: string }

const refusal = (error: unknown): McpPagesAnswer => {
  if (isDomainError(error)) return { ok: false, code: error.code, message: error.message }
  throw error
}

export class McpPagesService {
  readonly #store: McpPagesStore
  readonly #address: PagesAddress

  constructor(deps: { store: McpPagesStore; address: PagesAddress }) {
    this.#store = deps.store
    this.#address = deps.address
  }

  async publish(scope: McpTurnAccess, args: PagePublishToolArguments): Promise<McpPagesAnswer> {
    const parsed = pagePublishArgumentsSchema.safeParse(args)
    if (!parsed.success)
      return { ok: false, code: 'BAD_REQUEST', message: 'Give either file with title or docId' }
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
      })
      return {
        ok: true,
        value: {
          pageId: page.pageId,
          url: pageAddressUrl(page.slug, this.#address),
          version: page.version,
          live: 'when this turn ends',
          warnings:
            'file' in input
              ? [
                  `The page is made from the file ${input.file} of the outbox when this turn ends: write it there in this turn, self-contained.`,
                ]
              : ['The page is made from the finished version of the document when this turn ends.'],
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }

  async list(scope: McpTurnAccess): Promise<McpPagesAnswer> {
    try {
      const pages = await this.#store.list(scope.workspaceId)
      return {
        ok: true,
        value: {
          pages: pages.map((page) => ({
            pageId: page.id,
            title: page.title,
            url: pageAddressUrl(page.slug, this.#address),
            kind: page.kind,
            state: page.state,
            version: page.currentVersion,
            password: page.hasPassword,
            chat: page.taskId === scope.taskId ? 'this' : 'another',
          })),
        },
      }
    } catch (error) {
      return refusal(error)
    }
  }
}
