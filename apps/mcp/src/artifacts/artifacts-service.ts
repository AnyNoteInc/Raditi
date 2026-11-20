import { randomUUID } from 'node:crypto'

import {
  checkSectionText,
  DomainError,
  docPendingSections,
  docSectionWriteArgumentsSchema,
  isDomainError,
  pageContentRefused,
  type DocCreateArguments,
  type DocFinishArguments,
  type DocReadArguments,
  type DocSectionWriteShape,
  type FeedRow,
} from '@repo/domain'
import {
  artifactForbidden,
  artifactKindCreatable,
  artifactKindRefused,
  artifactLimit,
  artifactLimits,
  artifactNotFound,
  type ArtifactBatch,
  type ArtifactClaimArguments,
  type ArtifactCreateArguments,
  type ArtifactEditArguments,
  type ArtifactListArguments,
  type ArtifactListScope,
  type ArtifactOp,
  type ArtifactReadArguments,
  type ArtifactSaveVersionArguments,
} from '@repo/domain/artifacts'

import type { McpTurnAccess } from '../access/mcp-access.ts'

/**
 * The family `artifacts` (docs/plan/88-artifacts.md, Ар21–Ар24, §7.5; slice 88.6): what the chat may
 * open, read by blocks, created, changed by a batch of operations, claimed, a version. Every call
 * asks the role of the client of the chat (`artifactRole`, inside the store) and the bounds of the
 * chat (Ар23); a pass without its client changes only the client's own artifacts without a project
 * (Ар24). Each answer carries `seq`, what others changed since the chat read the artifact and which
 * of its writes the check of core sent back (Ар21, §7.3).
 *
 * The tools `doc_*` of plan 69 are synonyms (Ар3): a document is an artifact of the kind
 * «Документ», a section — a block. `doc_section_write` replaces under the revision the chat last
 * saw, `doc_section_remove` and `doc_section_move` delete and move under it, `doc_finish` waits
 * for the version of the end of the turn.
 */

export interface McpChatArtifactAccess {
  role: 'view' | 'comment' | 'edit' | 'owner'
  personal: boolean
  linked: boolean
}

export interface McpArtifactBlock {
  key: string
  kind: string
  parent: string | null
  rev: number
  content: string | null
  props: Record<string, string | number | boolean>
  checking: boolean
  hold: string | null
  intent?: string
}

export interface McpArtifactRead {
  id: string
  kind: string
  title: string
  seq: number
  version: number
  blocks: McpArtifactBlock[]
}

export interface McpArtifactNews {
  seq: number
  changedSinceYourRead: { count: number; blocks: string[]; more: boolean }
  refusedSinceYourRead: string[]
}

type Actor = { kind: 'agent'; taskId: string; turnNo: number; scheduled?: boolean }

export interface McpArtifactsStore {
  /** The project of the chat; null — a chat without one. */
  projectOf(taskId: string): Promise<string | null>
  access(taskId: string, artifactId: string): Promise<McpChatArtifactAccess | null>
  list(input: {
    taskId: string
    scope?: ArtifactListScope
    kind?: string
    query?: string
  }): Promise<{
    rows: {
      id: string
      kind: string
      title: string
      version: number
      updatedAt: Date
      place: ArtifactListScope
    }[]
    more: boolean
  }>
  read(actor: Actor, artifactId: string): Promise<McpArtifactRead>
  news(taskId: string, artifactId: string, read: boolean): Promise<McpArtifactNews>
  create(input: {
    workspaceId: string
    kind: string
    title: string
    projectId: string | null
    view?: 'page' | 'text'
    actor: Actor
  }): Promise<{ id: string; seq: number }>
  apply(batch: ArtifactBatch, actor: Actor): Promise<unknown>
  claim(input: {
    artifactId: string
    block: string
    intent: string
    actor: Actor
  }): Promise<{ until: Date }>
  saveVersion(artifactId: string, actor: Actor): Promise<{ no: number }>
  placeholders(artifactId: string): Promise<number>
  setView(artifactId: string, view: 'page' | 'text'): Promise<void>
  lastRev(taskId: string, artifactId: string, block: string): Promise<number | null>
  revision(artifactId: string): Promise<number>
  /** One more of a counted thing of this turn: false — its limit is reached. */
  admit(key: string, limit: number): Promise<boolean>
  feed(taskId: string, turnNo: number, row: FeedRow): Promise<void>
}

export type McpArtifactsAnswer =
  { ok: true; value: unknown } | { ok: false; code: string; message: string; details?: unknown }

const answerOf = async (work: () => Promise<unknown>): Promise<McpArtifactsAnswer> => {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    if (isDomainError(error))
      return {
        ok: false,
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      }
    throw error
  }
}

const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value))
const actorOf = (scope: McpTurnAccess): Actor => ({
  kind: 'agent',
  taskId: scope.taskId,
  turnNo: scope.turn,
  ...(scope.unattended ? { scheduled: true } : {}),
})

/** A pass without its client changes only the client's own artifacts without a project (Ар24). */
const unattendedRefusal = () =>
  new DomainError(
    'ARTIFACT_FORBIDDEN',
    'This pass runs on a schedule without the client: change only the client’s own artifacts without a project',
    403,
  )

/** Refuses text a page must not carry, by the checks this role can make (plan 69, Ст19). */
function assertText(...texts: string[]): void {
  for (const text of texts) {
    const verdict = checkSectionText(text)
    if (!verdict.ok) throw pageContentRefused(verdict.reason)
  }
}

/** The blocks from the first on while they fit `readPartBytes` — at least one, cut if alone. */
export function readPart<T extends { content: string | null }>(
  blocks: readonly T[],
): { blocks: (T & { cut?: true })[]; rest: number } {
  const part: (T & { cut?: true })[] = []
  let bytes = 0
  for (const block of blocks) {
    const size = utf8(block)
    if (part.length > 0 && bytes + size > artifactLimits.readPartBytes) break
    part.push(block)
    bytes += size
    if (bytes >= artifactLimits.readPartBytes) break
  }
  const first = part[0]
  if (
    part.length === 1 &&
    first &&
    first.content !== null &&
    bytes > artifactLimits.readPartBytes
  ) {
    let content = first.content
    while (utf8({ ...first, content, cut: true }) > artifactLimits.readPartBytes)
      // On a whole character: a cut through a surrogate pair would leave half of one.
      content = Array.from(content)
        .slice(0, Math.floor(Array.from(content).length * 0.9))
        .join('')
    part[0] = { ...first, content, cut: true }
  }
  return { blocks: part, rest: blocks.length - part.length }
}

const docSectionRefused = (issues: readonly { path: PropertyKey[]; message: string }[]) => ({
  ok: false as const,
  code: 'BAD_REQUEST',
  message: issues
    .map((issue) => `${issue.path.map(String).join('.') || 'arguments'}: ${issue.message}`)
    .join('; '),
})

export class McpArtifactsService {
  readonly #store: McpArtifactsStore

  constructor(deps: { store: McpArtifactsStore }) {
    this.#store = deps.store
  }

  /** The chat opens it (Ар23) with at least this; a pass without its client writes only its own. */
  async #open(scope: McpTurnAccess, artifactId: string, write: boolean) {
    const access = await this.#store.access(scope.taskId, artifactId)
    if (access === null) throw artifactNotFound()
    if (write && access.role !== 'edit' && access.role !== 'owner') throw artifactForbidden()
    if (write && scope.unattended && !access.personal) throw unattendedRefusal()
    return access
  }

  /** A read of an artifact this chat did not make or edit: at most 20 a turn (§7.5). */
  async #countForeign(scope: McpTurnAccess, artifactId: string, access: McpChatArtifactAccess) {
    if (access.linked) return
    const first = await this.#store.admit(
      `artifact-read:${scope.taskId}:${scope.turn}:${artifactId}`,
      1,
    )
    if (
      first &&
      !(await this.#store.admit(
        `artifact-foreign:${scope.taskId}:${scope.turn}`,
        artifactLimits.foreignReadsPerTurn,
      ))
    )
      throw artifactLimit('foreignReadsPerTurn')
  }

  list(scope: McpTurnAccess, args: ArtifactListArguments = {}): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      const { rows, more } = await this.#store.list({ taskId: scope.taskId, ...args })
      return {
        artifacts: rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          title: row.title,
          version: row.version,
          updatedAt: row.updatedAt.toISOString(),
          place: row.place,
        })),
        ...(more ? { more: true } : {}),
      }
    })
  }

  read(scope: McpTurnAccess, args: ArtifactReadArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      const access = await this.#open(scope, args.artifactId, false)
      await this.#countForeign(scope, args.artifactId, access)
      const artifact = await this.#store.read(actorOf(scope), args.artifactId)
      const news = await this.#store.news(scope.taskId, args.artifactId, true)
      let blocks = artifact.blocks
      if (args.blocks) blocks = blocks.filter((block) => args.blocks!.includes(block.key))
      if (args.sinceSeq !== undefined) {
        const changed = new Set(news.changedSinceYourRead.blocks)
        blocks = blocks.filter((block) => changed.has(block.key))
      }
      const start = args.from === undefined ? 0 : blocks.findIndex(({ key }) => key === args.from)
      if (start < 0) throw artifactNotFound()
      const rest = blocks.slice(start)
      const head = {
        artifactId: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        version: artifact.version,
        ...news,
        total: blocks.length,
      }
      const describe = (block: McpArtifactBlock) => ({
        id: block.key,
        kind: block.kind,
        ...(block.parent ? { parent: block.parent } : {}),
        rev: block.rev,
        ...(typeof block.props.heading === 'string' ? { heading: block.props.heading } : {}),
        ...(block.checking ? { checking: true } : {}),
        ...(block.hold ? { heldBy: block.hold } : {}),
      })
      if (args.part === 'outline') {
        const page = rest.slice(0, artifactLimits.outlinePageBlocks)
        const next = rest[page.length]
        return {
          ...head,
          outline: page.map((block) => ({
            ...describe(block),
            bytes: Buffer.byteLength(block.content ?? ''),
          })),
          ...(next ? { more: { from: next.key, blocks: rest.length - page.length } } : {}),
        }
      }
      const part = readPart(rest.map((block) => ({ ...describe(block), content: block.content })))
      const next = rest[part.blocks.length]
      return {
        ...head,
        blocks: part.blocks,
        ...(next ? { more: { from: next.key, blocks: part.rest } } : {}),
      }
    })
  }

  create(scope: McpTurnAccess, args: ArtifactCreateArguments): Promise<McpArtifactsAnswer> {
    return answerOf(() => this.#create(scope, args))
  }

  async #create(scope: McpTurnAccess, args: ArtifactCreateArguments) {
    if (!artifactKindCreatable(args.kind)) throw artifactKindRefused(args.kind)
    if (scope.unattended && args.project === 'this_chat') throw unattendedRefusal()
    // A new artifact of a chat of a project goes to the project (Ар42); a pass without its client
    // makes the client's own (Ар24).
    const chatProject = await this.#store.projectOf(scope.taskId)
    if (args.project === 'this_chat' && chatProject === null) throw artifactNotFound()
    const projectId = scope.unattended || args.project === null ? null : chatProject
    const created = await this.#store.create({
      workspaceId: scope.workspaceId,
      kind: args.kind,
      title: args.title,
      projectId,
      ...(args.view ? { view: args.view } : {}),
      actor: actorOf(scope),
    })
    const blocks = (args.skeleton ?? []).map((section) => section.id)
    if (args.skeleton && args.skeleton.length > 0) {
      const ops: ArtifactOp[] = args.skeleton.map((section, index) => ({
        op: 'insert',
        block: section.id,
        after: index === 0 ? null : args.skeleton![index - 1]!.id,
        kind: 'section',
        intent: section.intent,
      }))
      await this.#store.apply(
        { artifactId: created.id, opId: `skeleton-${randomUUID()}`, ops },
        actorOf(scope),
      )
    }
    // The tab beside the chat learns of it at once (a signal without text); the card of the feed
    // comes after the answer of the turn (Ар46).
    await this.#store.feed(scope.taskId, scope.turn, {
      type: 'feed.doc_touch',
      payload: { v: 1, docId: created.id, revision: await this.#store.revision(created.id) },
    })
    return {
      artifactId: created.id,
      kind: args.kind,
      ...(blocks.length > 0 ? { blocks } : {}),
      projectId,
      note: 'The client sees the title and the intents once the platform checked them. Write each block with artifact_edit.',
    }
  }

  edit(scope: McpTurnAccess, args: ArtifactEditArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      await this.#open(scope, args.artifactId, true)
      const answer = await this.#store.apply(args, actorOf(scope))
      return { ...(answer as object), ...(await this.#after(scope, args.artifactId)) }
    })
  }

  claim(scope: McpTurnAccess, args: ArtifactClaimArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      await this.#open(scope, args.artifactId, true)
      const { until } = await this.#store.claim({ ...args, actor: actorOf(scope) })
      return {
        artifactId: args.artifactId,
        block: args.block,
        until: until.toISOString(),
        ...(await this.#store.news(scope.taskId, args.artifactId, false)),
      }
    })
  }

  saveVersion(
    scope: McpTurnAccess,
    args: ArtifactSaveVersionArguments,
  ): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      await this.#open(scope, args.artifactId, true)
      if (
        !(await this.#store.admit(
          `artifact-versions:${scope.taskId}:${scope.turn}`,
          artifactLimits.agentVersionsPerTurn,
        ))
      )
        throw artifactLimit('agentVersionsPerTurn')
      const { no } = await this.#store.saveVersion(args.artifactId, actorOf(scope))
      return {
        artifactId: args.artifactId,
        version: no,
        // The agent's label is its text: until labels go through the check it is not kept (Ар19).
        ...(args.label ? { label: 'not kept: a version of the agent is an automatic one' } : {}),
        note: 'A version holds what the platform checked; the end of this turn makes one too.',
        ...(await this.#store.news(scope.taskId, args.artifactId, false)),
      }
    })
  }

  /** `seq`, the changes of others and the refusals of the check after a write of the chat (Ар21). */
  async #after(scope: McpTurnAccess, artifactId: string) {
    const news = await this.#store.news(scope.taskId, artifactId, false)
    const revision = await this.#store.revision(artifactId)
    await this.#store.feed(scope.taskId, scope.turn, {
      type: 'feed.doc_touch',
      payload: { v: 1, docId: artifactId, revision },
    })
    return news
  }

  // ———————————————————————————————— the synonyms of plan 69 (Ар3)

  docCreate(scope: McpTurnAccess, args: DocCreateArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      assertText(args.title, ...args.sections.map((section) => section.intent))
      const { artifactId } = await this.#create(scope, {
        kind: 'document',
        title: args.title,
        view: args.view,
        skeleton: args.sections,
      })
      return {
        docId: artifactId,
        sections: args.sections.map((section) => section.id),
        next: 'Write each section with doc_section_write, one a call; then doc_read to check, then doc_finish.',
      }
    })
  }

  async docWrite(scope: McpTurnAccess, shape: DocSectionWriteShape): Promise<McpArtifactsAnswer> {
    const parsed = docSectionWriteArgumentsSchema.safeParse(shape)
    if (!parsed.success) return docSectionRefused(parsed.error.issues)
    const args = parsed.data
    return answerOf(async () => {
      assertText(args.heading, args.markdown)
      await this.#open(scope, args.docId, true)
      const artifact = await this.#store.read(actorOf(scope), args.docId)
      const block = artifact.blocks.find((each) => each.key === args.id)
      let op: ArtifactOp
      if (block) {
        op = {
          op: 'replace',
          block: args.id,
          ifRev: (await this.#store.lastRev(scope.taskId, args.docId, args.id)) ?? block.rev,
          content: args.markdown,
          props: { heading: args.heading },
        }
      } else {
        const after =
          args.after !== undefined
            ? args.after
            : (artifact.blocks.filter((each) => each.parent === null).at(-1)?.key ?? null)
        op = {
          op: 'insert',
          block: args.id,
          after,
          kind: 'section',
          content: args.markdown,
          props: { heading: args.heading },
        }
      }
      await this.#store.apply(
        { artifactId: args.docId, opId: `doc-${randomUUID()}`, ops: [op] },
        actorOf(scope),
      )
      const news = await this.#after(scope, args.docId)
      return { docId: args.docId, id: args.id, written: true, revision: news.seq, ...news }
    })
  }

  docRemove(scope: McpTurnAccess, args: { docId: string; id: string }) {
    return this.#docBlock(scope, args.docId, args.id, (ifRev) => ({
      op: 'delete',
      block: args.id,
      ifRev,
    }))
  }

  docMove(scope: McpTurnAccess, args: { docId: string; id: string; after: string | null }) {
    return this.#docBlock(scope, args.docId, args.id, (ifRev) => ({
      op: 'move',
      block: args.id,
      ifRev,
      after: args.after,
    }))
  }

  #docBlock(
    scope: McpTurnAccess,
    docId: string,
    key: string,
    op: (ifRev: number) => ArtifactOp,
  ): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      await this.#open(scope, docId, true)
      const artifact = await this.#store.read(actorOf(scope), docId)
      const block = artifact.blocks.find((each) => each.key === key)
      if (!block) throw artifactNotFound()
      const ifRev = (await this.#store.lastRev(scope.taskId, docId, key)) ?? block.rev
      await this.#store.apply(
        { artifactId: docId, opId: `doc-${randomUUID()}`, ops: [op(ifRev)] },
        actorOf(scope),
      )
      const news = await this.#after(scope, docId)
      return { docId, id: key, done: true, revision: news.seq, ...news }
    })
  }

  docRead(scope: McpTurnAccess, args: DocReadArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      const access = await this.#open(scope, args.docId, false)
      await this.#countForeign(scope, args.docId, access)
      const artifact = await this.#store.read(actorOf(scope), args.docId)
      const news = await this.#store.news(scope.taskId, args.docId, true)
      const sections = artifact.blocks
        .filter((block) => block.kind === 'section')
        .map((block) => ({
          id: block.key,
          intent: block.intent ?? '',
          state: block.content === null ? 'pending' : 'written',
          heading: typeof block.props.heading === 'string' ? block.props.heading : null,
          content: block.content,
        }))
      const start = args.from === undefined ? 0 : sections.findIndex(({ id }) => id === args.from)
      if (start < 0) throw artifactNotFound()
      const part = readPart(sections.slice(start))
      const next = sections[start + part.blocks.length]
      return {
        docId: artifact.id,
        title: artifact.title,
        version: artifact.version,
        total: sections.length,
        sections: part.blocks.map(({ content, ...rest }) => ({ ...rest, markdown: content })),
        ...(next ? { more: { from: next.id, sections: part.rest } } : {}),
        ...news,
      }
    })
  }

  docFinish(scope: McpTurnAccess, args: DocFinishArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      await this.#open(scope, args.docId, true)
      const pending = await this.#store.placeholders(args.docId)
      if (pending > 0) throw docPendingSections(pending)
      if (args.view) await this.#store.setView(args.docId, args.view)
      return {
        docId: args.docId,
        finished: 'when this turn ends',
        note: 'The version is made at the end of this turn of what passed the checks of the platform; a section that did not keeps its text before.',
      }
    })
  }
}
