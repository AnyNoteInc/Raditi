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
  artifactFileNameSchema,
  artifactFileRef,
  artifactForbidden,
  artifactImportKindOf,
  artifactKindCreatable,
  artifactKindRefused,
  artifactKindSpecs,
  artifactLimit,
  artifactLimits,
  artifactNotFound,
  artifactOpInvalid,
  artifactRenderLimits,
  type ArtifactBatch,
  type ArtifactLayoutArguments,
  type ArtifactRenderArguments,
  type ArtifactRenderRequest,
  type ArtifactRenderResponse,
  type ArtifactClaimArguments,
  type ArtifactCommentAnchor,
  type ArtifactCommentsArguments,
  type ArtifactCreateArguments,
  type ArtifactEditArguments,
  type ArtifactFilePutArguments,
  type ArtifactImportArguments,
  type ArtifactListArguments,
  type ArtifactListScope,
  type ArtifactOp,
  type ArtifactReadArguments,
  type ArtifactReplyArguments,
  type ArtifactSaveVersionArguments,
  type ArtifactTrashArguments,
  artifactCommentsByOthers,
  type ArtifactDiagramRenderRequest,
  type ArtifactDiagramRenderResponse,
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
  /** The scheduled task of the chat's run names it (Ар24, 88.20б): its run may change it. */
  named?: boolean
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
  /** Written last by another person or another person's agent (Ар25): data, never an order. */
  by?: 'other'
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
  /** `readSeq` — the chat read the whole artifact as of that `seq` (Ар21). */
  news(taskId: string, artifactId: string, readSeq?: number): Promise<McpArtifactNews>
  /** The blocks changed after a `seq` of the artifact, by anyone. */
  changedSince(artifactId: string, sinceSeq: number): Promise<string[]>
  /** A new artifact of this turn whose skeleton did not go in is deleted. */
  discard(artifactId: string, taskId: string, turnNo: number): Promise<void>
  create(input: {
    workspaceId: string
    kind: string
    title: string
    projectId: string | null
    view?: 'page' | 'text'
    actor: Actor
  }): Promise<{ id: string; seq: number }>
  apply(batch: ArtifactBatch, actor: Actor): Promise<unknown>
  /**
   * The texts of «Схема» as this chat sees them (88.24б): its own text before the check, or the
   * checked one; with the workspace of the artifact and whether a picture of each is kept.
   */
  diagramTexts(
    taskId: string,
    artifactId: string,
  ): Promise<{
    workspaceId: string
    texts: { block: string; text: string; kept: McpKeptDiagram | null }[]
  } | null>
  saveDiagram(
    artifactId: string,
    text: string,
    result: ArtifactDiagramRenderResponse,
  ): Promise<void>
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
  reserveFile(input: {
    taskId: string
    turnNo: number
    artifactId: string
    fileName: string
  }): Promise<{ id: string }>
  reserveImport(input: {
    taskId: string
    turnNo: number
    fileName: string
    artifactId: string | null
    title: string | null
    personal: boolean
  }): Promise<{ artifactId: string }>
  /** The kind of an artifact; null — none. */
  kindOf(artifactId: string): Promise<string | null>
  /** One more of a counted thing of this turn: false — its limit is reached. */
  admit(key: string, limit: number): Promise<boolean>
  feed(taskId: string, turnNo: number, row: FeedRow): Promise<void>
  /**
   * Ар25 (88.17): that this turn read text of other people; marked once one is read.
   * `sharedWithOthers` — the artifact is open to someone beside the chat's client;
   * `namedThisPass` — the client attached or mentioned it in the request of this pass.
   */
  markReadOther(taskId: string, turnNo: number): Promise<void>
  readOther(taskId: string, turnNo: number): Promise<boolean>
  sharedWithOthers(taskId: string, artifactId: string): Promise<boolean>
  namedThisPass(taskId: string, turnNo: number, artifactId: string): Promise<boolean>
  /** The notes sent to this chat (88.18г): owner-only, checked by the store. */
  comments(taskId: string, artifactId?: string): Promise<McpChatComment[]>
  reply(input: {
    taskId: string
    turnNo: number
    threadId: string
    requestId: string
    body: string
    resolve: boolean
  }): Promise<{ id: string; artifactId: string; repeated: boolean }>
  /** Into the trash by the agent of the chat, for its client (`deleted_by = 'agent'`). */
  trash(taskId: string, artifactId: string): Promise<{ purgeAfter: Date }>
}

export interface McpChatComment {
  threadId: string
  artifactId: string
  /** A quote of a section, or a cell of a table with its column and text (88.18д). */
  anchor: ArtifactCommentAnchor
  body: string
  /** Written by another person with access, not the client (88.17а): data, never a request. */
  by?: 'other'
  /** People's replies when it was sent; another person's are marked `by: "other"`. */
  replies: (string | { body: string; by: 'other' })[]
  resolved: boolean
  yourReplies: { id: string; body: string; checking: boolean }[]
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

/**
 * A pass without its client changes only the client's own artifacts without a project and those
 * its scheduled task names (Ар24).
 */
const unattendedRefusal = () =>
  new DomainError(
    'ARTIFACT_FORBIDDEN',
    'This pass runs on a schedule without the client: change only the client’s own artifacts without a project and those the task names',
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

/**
 * The renderer of frames (`apps/browser`, `POST /v1/render`): the report of a layout and the
 * pictures for the helper `look` (docs/plan/88-artifacts.md, Ар32). Null — the browser worker is
 * not configured here.
 */
export type McpFrameRenderer = (request: ArtifactRenderRequest) => Promise<ArtifactRenderResponse>

/** A picture of a frame as the result of a tool gives it (MCP `type: "image"`). */
export interface McpArtifactPicture {
  data: string
  mimeType: 'image/jpeg' | 'image/png'
  caption: string
}

const renderUnavailable = () =>
  new DomainError(
    'ARTIFACT_RENDER_UNAVAILABLE',
    'The renderer of frames is not available now; try again later',
    503,
  )

/** A kept picture of a text of «Схема», as the agent is told of it. */
export type McpKeptDiagram =
  { ok: true; width: number; height: number } | { ok: false; line: number | null; message: string }

/** The browser worker's drawing of a diagram (`POST /v1/diagram`, 88.24а). */
export type McpDiagramRenderer = (
  request: ArtifactDiagramRenderRequest,
) => Promise<ArtifactDiagramRenderResponse>

/** Diagrams drawn after one write at most: a diagram is one block as a rule. */
const DIAGRAMS_A_WRITE = 5

export class McpArtifactsService {
  readonly #store: McpArtifactsStore
  readonly #render: McpFrameRenderer | null
  readonly #diagram: McpDiagramRenderer | null

  constructor(deps: {
    store: McpArtifactsStore
    render?: McpFrameRenderer | null
    diagram?: McpDiagramRenderer | null
  }) {
    this.#store = deps.store
    this.#render = deps.render ?? null
    this.#diagram = deps.diagram ?? null
  }

  /** The renderer, or a refusal the agent reads; its own refusals become the artifact's words. */
  async #draw(request: ArtifactRenderRequest): Promise<ArtifactRenderResponse> {
    if (this.#render === null) throw renderUnavailable()
    try {
      return await this.#render(request)
    } catch (error) {
      if (isDomainError(error) && error.code === 'RENDER_NOT_FOUND') throw artifactNotFound()
      if (isDomainError(error) && error.code === 'RENDER_NOT_A_FRAME')
        throw artifactOpInvalid('only a mockup or a frame of a canvas is drawn')
      throw renderUnavailable()
    }
  }

  /**
   * `artifact_layout` (§7.5, Ар32): the English report of the layout of a mockup or of a frame of a
   * canvas at 1440 and 390, as the client would see it with this chat's own unchecked blocks.
   */
  layout(scope: McpTurnAccess, args: ArtifactLayoutArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      await this.#open(scope, args.artifactId, false)
      if (
        !(await this.#store.admit(
          `artifact-layout:${scope.taskId}:${scope.turn}`,
          artifactRenderLimits.layoutsPerTurn,
        ))
      )
        throw artifactLimit('layoutsPerTurn')
      const answer = await this.#draw({
        artifactId: args.artifactId,
        frame: args.frame ?? null,
        viewer: { kind: 'agent', taskId: scope.taskId, turnNo: scope.turn },
        output: 'layout',
        ...(args.detail ? { detail: true } : {}),
      })
      return { report: answer.report, problems: answer.problems, heights: answer.heights }
    })
  }

  /**
   * `artifact_render` (§7.5, Ар32, slice 88.15в): strips of JPEG of a mockup or a frame for the helper
   * `look` — at most 3 checks a turn and 4 pictures a check —, with the short report beside them.
   */
  async render(
    scope: McpTurnAccess,
    args: ArtifactRenderArguments,
  ): Promise<{ answer: McpArtifactsAnswer; pictures: McpArtifactPicture[] }> {
    const pictures: McpArtifactPicture[] = []
    const answer = await answerOf(async () => {
      await this.#open(scope, args.artifactId, false)
      if (
        !(await this.#store.admit(
          `artifact-render:${scope.taskId}:${scope.turn}`,
          artifactRenderLimits.looksPerTurn,
        ))
      )
        throw artifactLimit('looksPerTurn')
      const widths =
        args.view === 'desktop'
          ? [artifactRenderLimits.viewportWidths.desktop]
          : args.view === 'phone'
            ? [artifactRenderLimits.viewportWidths.phone]
            : [
                artifactRenderLimits.viewportWidths.desktop,
                artifactRenderLimits.viewportWidths.phone,
              ]
      const drawn = await this.#draw({
        artifactId: args.artifactId,
        frame: args.frame ?? null,
        viewer: { kind: 'agent', taskId: scope.taskId, turnNo: scope.turn },
        output: 'image',
        widths: widths as ArtifactRenderRequest['widths'],
      })
      for (const picture of drawn.pictures.slice(0, artifactRenderLimits.picturesPerLook))
        pictures.push({
          data: picture.data,
          mimeType: picture.type,
          caption: `${picture.width} px wide, from y ${picture.part * artifactRenderLimits.stripPx}`,
        })
      return { pictures: pictures.map((picture) => picture.caption), report: drawn.report }
    })
    return { answer, pictures: answer.ok ? pictures : [] }
  }

  /** The chat opens it (Ар23) with at least this; a pass without its client writes only its own. */
  async #open(
    scope: McpTurnAccess,
    artifactId: string,
    write: boolean,
    // A claim and a version change nothing others read: a pass without its client makes them
    // anywhere it may write (§7.5).
    changes = write,
  ) {
    const access = await this.#store.access(scope.taskId, artifactId)
    if (access === null) throw artifactNotFound()
    if (write && access.role !== 'edit' && access.role !== 'owner') throw artifactForbidden()
    if (changes && scope.unattended && !access.personal && !access.named) throw unattendedRefusal()
    return access
  }

  /**
   * Ар25 (slice 88.17): a pass that read the text of other people writes into an artifact opened
   * to others only when the client named that artifact in this pass — words of others are never
   * a reason to change what others read.
   */
  async #guardOthersText(scope: McpTurnAccess, artifactId: string) {
    if (!(await this.#store.readOther(scope.taskId, scope.turn))) return
    if (!(await this.#store.sharedWithOthers(scope.taskId, artifactId))) return
    if (await this.#store.namedThisPass(scope.taskId, scope.turn, artifactId)) return
    throw new DomainError(
      'ARTIFACT_FORBIDDEN',
      'This turn read text of other people: change an artifact others can open only when the client named it in this request',
      403,
    )
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
      const news = await this.#store.news(scope.taskId, args.artifactId)
      let blocks = artifact.blocks
      if (args.blocks) blocks = blocks.filter((block) => args.blocks!.includes(block.key))
      if (args.sinceSeq !== undefined) {
        const changed = new Set(await this.#store.changedSince(args.artifactId, args.sinceSeq))
        blocks = blocks.filter((block) => changed.has(block.key))
      }
      // Only a read of the whole text in one answer is a read of everything others changed (Ар21).
      const whole =
        args.part !== 'outline' &&
        args.blocks === undefined &&
        args.sinceSeq === undefined &&
        args.from === undefined
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
        ...(block.by ? { by: block.by } : {}),
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
      // The text of other people was read (Ар25): the turn writes no artifact opened to others
      // beyond those the client named in this pass.
      if (part.blocks.some((block) => block.by === 'other'))
        await this.#store.markReadOther(scope.taskId, scope.turn)
      if (whole && !next) await this.#store.news(scope.taskId, args.artifactId, artifact.seq)
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
    // A skeleton is of sections; a kind without them (a table) writes its blocks by artifact_edit.
    if (
      args.skeleton &&
      args.skeleton.length > 0 &&
      !artifactKindSpecs[args.kind].blocks.includes('section')
    )
      throw artifactOpInvalid('this kind has no skeleton: write its blocks with artifact_edit')
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
      try {
        await this.#store.apply(
          { artifactId: created.id, opId: `skeleton-${randomUUID()}`, ops },
          actorOf(scope),
        )
      } catch (error) {
        // Not half an artifact: the call failed as a whole and costs the turn no creation.
        await this.#store.discard(created.id, scope.taskId, scope.turn)
        throw error
      }
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
      await this.#guardOthersText(scope, args.artifactId)
      const answer = await this.#store.apply(args, actorOf(scope))
      const diagrams = await this.#diagrams(scope, args.artifactId)
      return {
        ...(answer as object),
        ...(diagrams ? { diagrams } : {}),
        ...(await this.#after(scope, args.artifactId)),
      }
    })
  }

  /**
   * A write to «Схема» is drawn at once (§7.5, 88.24б): the agent reads in the answer whether each
   * diagram parsed, and the line of its error. The client sees the picture once the text is checked.
   */
  async #diagrams(scope: McpTurnAccess, artifactId: string) {
    const target = await this.#store.diagramTexts(scope.taskId, artifactId)
    if (target === null || target.texts.length === 0) return null
    const told: Record<string, unknown>[] = []
    for (const { block, text, kept } of target.texts.slice(0, DIAGRAMS_A_WRITE)) {
      let result: McpKeptDiagram | null = kept
      if (result === null && this.#diagram !== null) {
        try {
          const drawn = await this.#diagram({ workspaceId: target.workspaceId, source: text })
          await this.#store.saveDiagram(artifactId, text, drawn)
          result = drawn.ok
            ? { ok: true, width: drawn.width, height: drawn.height }
            : { ok: false, line: drawn.line, message: drawn.message }
        } catch {
          result = null
        }
      }
      told.push(
        result === null
          ? { block, drawn: null, note: 'Not drawn now: the client sees the picture once it is.' }
          : result.ok
            ? { block, drawn: true, width: result.width, height: result.height }
            : {
                block,
                drawn: false,
                ...(result.line === null ? {} : { line: result.line }),
                error: result.message,
                fix: 'Fix the text of the diagram and write it again.',
              },
      )
    }
    return told
  }

  claim(scope: McpTurnAccess, args: ArtifactClaimArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      await this.#open(scope, args.artifactId, true, false)
      const { until } = await this.#store.claim({ ...args, actor: actorOf(scope) })
      return {
        artifactId: args.artifactId,
        block: args.block,
        until: until.toISOString(),
        ...(await this.#store.news(scope.taskId, args.artifactId)),
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
        ...(await this.#store.news(scope.taskId, args.artifactId)),
      }
    })
  }

  /**
   * `artifact_file_put` (§7.5): a picture or a font of the outbox for an artifact the chat writes;
   * the reference goes into the content now, the bytes come at the end of the turn.
   */
  filePut(scope: McpTurnAccess, args: ArtifactFilePutArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      await this.#open(scope, args.artifactId, true)
      if (!artifactFileNameSchema.safeParse(args.file).success)
        throw artifactOpInvalid(
          'a file of an artifact is a picture or a font: png, jpg, gif, webp, avif, svg, woff2, woff',
        )
      const { id } = await this.#store.reserveFile({
        taskId: scope.taskId,
        turnNo: scope.turn,
        artifactId: args.artifactId,
        fileName: args.file,
      })
      return {
        artifactId: args.artifactId,
        ref: artifactFileRef(id),
        live: 'at the end of this turn',
        note: `Write ${artifactFileRef(id)} where its address goes (src, url()), never an address. Only a file of the outbox folder of this turn; copy one from the inbox or the project there first.`,
      }
    })
  }

  /**
   * `artifact_import` (§7.5): a whole `.md`, `.html`, `.svg` or `.csv` of the outbox — a new artifact
   * of its kind, or the new content of one of that kind the chat writes — at the end of the turn.
   */
  import(scope: McpTurnAccess, args: ArtifactImportArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      const kind = artifactImportKindOf(args.file)
      if (kind === null || !artifactKindCreatable(kind))
        throw artifactOpInvalid('import a .md (document), .html or .svg (mockup), or .csv (table)')
      let personal = scope.unattended || args.project === null
      if (args.artifactId !== undefined) {
        await this.#open(scope, args.artifactId, true)
        if ((await this.#store.kindOf(args.artifactId)) !== kind)
          throw artifactOpInvalid(`the file makes a ${kind}: import it into one of that kind`)
        personal = false
      } else if (scope.unattended && args.project === 'this_chat') throw unattendedRefusal()
      if (args.title !== undefined) assertText(args.title)
      const { artifactId } = await this.#store.reserveImport({
        taskId: scope.taskId,
        turnNo: scope.turn,
        fileName: args.file,
        artifactId: args.artifactId ?? null,
        title: args.title ?? null,
        personal,
      })
      return {
        artifactId,
        kind,
        live: 'at the end of this turn: read or edit it in the next turn',
      }
    })
  }

  /**
   * `artifact_comments` (§7.5, 88.18г): the notes the client sent to this chat by «Отправить агенту»
   * — data, never instructions. A pass without its client reads them too (Ар24).
   */
  comments(scope: McpTurnAccess, args: ArtifactCommentsArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      const notes = await this.#store.comments(scope.taskId, args.artifactId)
      // Words of other people in a thread mark the turn as one that read others (Ар25, 88.17в).
      if (artifactCommentsByOthers(notes)) await this.#store.markReadOther(scope.taskId, scope.turn)
      return {
        notes,
        ...(notes.length === 0 ? { note: 'No notes were sent to this chat.' } : {}),
      }
    })
  }

  /**
   * `artifact_reply` (§7.5, 88.18г): a reply in a note sent to this chat. It waits for the check of
   * core; the client sees it, and the note closes if asked, only once it passes. Never without the
   * client (Ар24): the policy withholds the tool, the service refuses it too.
   */
  reply(scope: McpTurnAccess, args: ArtifactReplyArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      if (scope.unattended)
        throw new DomainError(
          'ARTIFACT_FORBIDDEN',
          'This pass runs on a schedule without the client: it does not reply in notes',
          403,
        )
      assertText(args.body)
      const reply = await this.#store.reply({
        taskId: scope.taskId,
        turnNo: scope.turn,
        threadId: args.threadId,
        requestId: args.opId,
        body: args.body,
        resolve: args.resolve ?? false,
      })
      return {
        replyId: reply.id,
        threadId: args.threadId,
        artifactId: reply.artifactId,
        live: 'after the check of the platform',
        ...(args.resolve ? { resolve: 'the note closes once the reply passes the check' } : {}),
        ...(reply.repeated ? { repeated: true } : {}),
      }
    })
  }

  /**
   * `artifact_trash` (§7.5, Ар23, slice 88.20): only an artifact the client owns, on their word
   * (`confirmedByClient`), at most 20 a turn; never without the client (Ар24) — the policy
   * withholds it, the service refuses it too. 30 days in the trash, «Вернуть» is the client's.
   */
  trash(scope: McpTurnAccess, args: ArtifactTrashArguments): Promise<McpArtifactsAnswer> {
    return answerOf(async () => {
      if (scope.unattended)
        throw new DomainError(
          'ARTIFACT_FORBIDDEN',
          'This pass runs on a schedule without the client: it does not delete artifacts',
          403,
        )
      const access = await this.#store.access(scope.taskId, args.artifactId)
      if (access === null) throw artifactNotFound()
      if (access.role !== 'owner') throw artifactForbidden()
      if (
        !(await this.#store.admit(
          `artifact-trash:${scope.taskId}:${scope.turn}`,
          artifactLimits.agentTrashPerTurn,
        ))
      )
        throw artifactLimit('agentTrashPerTurn')
      const { purgeAfter } = await this.#store.trash(scope.taskId, args.artifactId)
      return {
        artifactId: args.artifactId,
        trashed: true,
        purgeAfter: purgeAfter.toISOString(),
        note: 'The client can bring it back from «Корзина» of «Артефакты» until then.',
      }
    })
  }

  /** `seq`, the changes of others and the refusals of the check after a write of the chat (Ар21). */
  async #after(scope: McpTurnAccess, artifactId: string) {
    const news = await this.#store.news(scope.taskId, artifactId)
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
      const news = await this.#store.news(scope.taskId, args.docId)
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
      if (args.from === undefined && !next)
        await this.#store.news(scope.taskId, args.docId, artifact.seq)
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
