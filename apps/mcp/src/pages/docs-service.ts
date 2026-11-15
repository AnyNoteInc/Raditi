import {
  checkSectionText,
  DomainError,
  docSectionWriteArgumentsSchema,
  isDomainError,
  pageContentRefused,
  pageLimits,
  type DocCreateArguments,
  type DocFinishArguments,
  type DocReadArguments,
  type DocSectionWriteShape,
  type DocView,
  type FeedRow,
} from '@repo/domain'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import type { McpPagesAnswer } from './pages-service.ts'

/**
 * The documents the agent writes section by section (docs/plan/69-pages.md, Ст7, Ст19, Ст21, Ст22):
 * the skeleton first, a section a call, `doc_read` to check, `doc_finish` to make the version at
 * the end of the turn. The role checks what it can without the values of the client — sizes,
 * keys of the turn, tokens —; core checks the rest at the end of the turn, and until then the
 * client sees the headings of nothing but the skeleton. Every change writes a signal row for the
 * card (`feed.doc_touch`); the text never goes into the feed.
 */

export interface McpDocsStore {
  create(input: {
    workspaceId: string
    taskId: string
    title: string
    view: DocView
    sections: { key: string; intent: string }[]
  }): Promise<{ id: string; revision: number }>
  write(input: {
    workspaceId: string
    documentId: string
    key: string
    heading: string
    markdown: string
    after?: string | null
    taskId: string
    turnNo: number
  }): Promise<{ revision: number }>
  remove(input: {
    workspaceId: string
    documentId: string
    key: string
  }): Promise<{ revision: number }>
  move(input: {
    workspaceId: string
    documentId: string
    key: string
    after: string | null
  }): Promise<{ revision: number }>
  read(input: { workspaceId: string; documentId: string; taskId: string }): Promise<{
    id: string
    title: string
    revision: number
    version: number
    sections: {
      key: string
      heading: string | null
      intent: string
      state: string
      markdown: string | null
      checked: boolean
      refusal: string | null
    }[]
  }>
  finish(input: {
    workspaceId: string
    documentId: string
    taskId: string
    turnNo: number
    view?: DocView
  }): Promise<void>
  /** One more write of this turn: false — `pageLimits.sectionWritesPerTurn` is reached. */
  admitWrite(taskId: string, turnNo: number): Promise<boolean>
  /** A row of the chat's feed, under the turn. */
  feed(taskId: string, turnNo: number, row: FeedRow): Promise<void>
}

const answerOf = async (work: () => Promise<unknown>): Promise<McpPagesAnswer> => {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    if (isDomainError(error)) return { ok: false, code: error.code, message: error.message }
    throw error
  }
}

/** Refuses text a page must not carry, by the checks this role can make (Ст19). */
function assertText(...texts: string[]): void {
  for (const text of texts) {
    const verdict = checkSectionText(text)
    if (!verdict.ok) throw pageContentRefused(verdict.reason)
  }
}

/**
 * The JSON of the sections one `doc_read` answers with: the role's answers stay under the limit
 * of its journal (64 KiB, `mcpCanonicalJson`) with the title and the rest around them.
 */
export const docReadPartBytes = 48 * 1024

interface ReadSection {
  id: string
  markdown: string | null
}

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

/**
 * The sections from the first on while they fit `docReadPartBytes` — at least one. A single
 * section whose JSON alone is larger (a section is at most 32 KiB, its escapes may double it)
 * comes cut, with `cut: true`.
 */
export function readPart<T extends ReadSection>(sections: readonly T[]): { sections: T[] } {
  const part: T[] = []
  let bytes = 0
  for (const section of sections) {
    const size = jsonBytes(section)
    if (part.length > 0 && bytes + size > docReadPartBytes) break
    part.push(section)
    bytes += size
    if (bytes >= docReadPartBytes) break
  }
  const first = part[0]
  if (part.length === 1 && first && first.markdown !== null && bytes > docReadPartBytes) {
    let markdown = first.markdown
    while (jsonBytes({ ...first, markdown, cut: true }) > docReadPartBytes)
      // On a whole character: a cut through a surrogate pair would leave half of one.
      markdown = Array.from(markdown)
        .slice(0, Math.floor(Array.from(markdown).length * 0.9))
        .join('')
    part[0] = { ...first, markdown, cut: true }
  }
  return { sections: part }
}

/** What is wrong with a section write, in the schema's own words: never the text itself. */
const sectionRefused = (issues: readonly { path: PropertyKey[]; message: string }[]) => ({
  ok: false as const,
  code: 'BAD_REQUEST',
  message: issues
    .map((issue) => `${issue.path.map(String).join('.') || 'arguments'}: ${issue.message}`)
    .join('; '),
})

const tooManyWrites = () => ({
  ok: false as const,
  code: 'DOC_LIMIT',
  message: `The writes of sections of this turn (${pageLimits.sectionWritesPerTurn}) are used up: finish in the next turn.`,
})

export class McpDocsService {
  readonly #store: McpDocsStore

  constructor(deps: { store: McpDocsStore }) {
    this.#store = deps.store
  }

  create(scope: McpTurnAccess, args: DocCreateArguments): Promise<McpPagesAnswer> {
    return answerOf(async () => {
      assertText(args.title, ...args.sections.map((section) => section.intent))
      const document = await this.#store.create({
        workspaceId: scope.workspaceId,
        taskId: scope.taskId,
        title: args.title,
        view: args.view,
        sections: args.sections.map((section) => ({ key: section.id, intent: section.intent })),
      })
      await this.#store.feed(scope.taskId, scope.turn, {
        type: 'feed.doc',
        payload: { v: 1, docId: document.id },
      })
      return {
        docId: document.id,
        sections: args.sections.map((section) => section.id),
        next: 'Write each section with doc_section_write, one a call; then doc_read to check, then doc_finish.',
      }
    })
  }

  async write(scope: McpTurnAccess, shape: DocSectionWriteShape): Promise<McpPagesAnswer> {
    // Before a write is counted: a section the agent fixes and sends again costs one write.
    const parsed = docSectionWriteArgumentsSchema.safeParse(shape)
    if (!parsed.success) return sectionRefused(parsed.error.issues)
    const args = parsed.data
    if (!(await this.#store.admitWrite(scope.taskId, scope.turn))) return tooManyWrites()
    return answerOf(async () => {
      assertText(args.heading, args.markdown)
      const { revision } = await this.#store.write({
        workspaceId: scope.workspaceId,
        documentId: args.docId,
        key: args.id,
        heading: args.heading,
        markdown: args.markdown,
        ...(args.after === undefined ? {} : { after: args.after }),
        taskId: scope.taskId,
        turnNo: scope.turn,
      })
      await this.#touch(scope, args.docId, revision)
      return { docId: args.docId, id: args.id, written: true, revision }
    })
  }

  async remove(scope: McpTurnAccess, args: { docId: string; id: string }): Promise<McpPagesAnswer> {
    if (!(await this.#store.admitWrite(scope.taskId, scope.turn))) return tooManyWrites()
    return answerOf(async () => {
      const { revision } = await this.#store.remove({
        workspaceId: scope.workspaceId,
        documentId: args.docId,
        key: args.id,
      })
      await this.#touch(scope, args.docId, revision)
      return { docId: args.docId, id: args.id, removed: true, revision }
    })
  }

  async move(
    scope: McpTurnAccess,
    args: { docId: string; id: string; after: string | null },
  ): Promise<McpPagesAnswer> {
    if (!(await this.#store.admitWrite(scope.taskId, scope.turn))) return tooManyWrites()
    return answerOf(async () => {
      const { revision } = await this.#store.move({
        workspaceId: scope.workspaceId,
        documentId: args.docId,
        key: args.id,
        after: args.after,
      })
      await this.#touch(scope, args.docId, revision)
      return { docId: args.docId, id: args.id, moved: true, revision }
    })
  }

  read(scope: McpTurnAccess, args: DocReadArguments): Promise<McpPagesAnswer> {
    return answerOf(async () => {
      const document = await this.#store.read({
        workspaceId: scope.workspaceId,
        documentId: args.docId,
        taskId: scope.taskId,
      })
      const sections = document.sections.map((section) => ({
        id: section.key,
        intent: section.intent,
        state: section.state,
        heading: section.heading,
        markdown: section.markdown,
        ...(section.refusal ? { refused: section.refusal } : {}),
      }))
      const start = args.from === undefined ? 0 : sections.findIndex(({ id }) => id === args.from)
      if (start < 0)
        throw new DomainError('BAD_REQUEST', 'The document has no section with this id', 400)
      const part = readPart(sections.slice(start))
      const rest = sections.length - start - part.sections.length
      return {
        docId: document.id,
        title: document.title,
        version: document.version,
        total: sections.length,
        sections: part.sections,
        ...(rest > 0
          ? { more: { from: sections[start + part.sections.length]!.id, sections: rest } }
          : {}),
      }
    })
  }

  finish(scope: McpTurnAccess, args: DocFinishArguments): Promise<McpPagesAnswer> {
    return answerOf(async () => {
      await this.#store.finish({
        workspaceId: scope.workspaceId,
        documentId: args.docId,
        taskId: scope.taskId,
        turnNo: scope.turn,
        ...(args.view ? { view: args.view } : {}),
      })
      return {
        docId: args.docId,
        finished: 'when this turn ends',
        note: 'The version is made at the end of this turn if every section passes the checks of the platform; a section that does not becomes a placeholder again.',
      }
    })
  }

  async #touch(scope: McpTurnAccess, docId: string, revision: number): Promise<void> {
    await this.#store.feed(scope.taskId, scope.turn, {
      type: 'feed.doc_touch',
      payload: { v: 1, docId, revision },
    })
  }
}
