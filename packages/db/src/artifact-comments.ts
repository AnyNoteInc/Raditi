import { secretInContent } from '@repo/domain'
import {
  artifactCommentDispatchLimits,
  artifactCommentDispatchTooLarge,
  artifactCommentSnapshotSchema,
  artifactCommentUnavailable,
  artifactKindSpecOf,
  artifactLimit,
  artifactLimits,
  artifactNotFound,
  artifactOpReused,
  artifactSecretShape,
  artifactStale,
  artifactCellsSchema,
  commentCellText,
  tableCellText,
  tableOfBlocks,
  type ArtifactCellAnchor,
  type ArtifactCellAnchorInput,
  type ArtifactCommentAnchor,
  type ArtifactCommentAnchorInput,
  type ArtifactCommentSnapshot,
  artifactForbidden,
  artifactRoleAtLeast,
  type ArtifactRole,
} from '@repo/domain/artifacts'

import { dataClassesAllow } from './artifact-chats.ts'
import { artifactRole, lockArtifact } from './artifacts.ts'
import { artifactAddressees, oriTerms, recordOriFact, type OriOrigin } from './ori.ts'
import { enqueueArtifactNotify } from './task-commands-outbox.ts'
import { accessibleTasks } from './chat-access.ts'
import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
import { admitInWindow } from './page-passwords.ts'
import { blockCheckedText } from './pages.ts'

type Owner = { artifactId: string; userId: string }
type Db = Pick<PrismaClient, '$transaction'>

async function requireOwner(tx: Prisma.TransactionClient, input: Owner) {
  if ((await artifactRole(tx, input)) !== 'owner') throw artifactNotFound()
}

async function lockOwnedArtifact(tx: Prisma.TransactionClient, input: Owner) {
  await requireOwner(tx, input)
  const artifact = await lockArtifact(tx, input.artifactId)
  await requireOwner(tx, input)
  return artifact
}

/**
 * The artifact of a kind that takes notes, under its lock, for a reader of at least `needed`
 * (88.17а): an owner's private note needs the owner, a shared thread «Комментирует».
 */
async function lockNotesFor(
  tx: Prisma.TransactionClient,
  input: Owner,
  needed: 'view' | 'comment' | 'owner',
) {
  const artifact = await lockArtifact(tx, input.artifactId)
  const role = await artifactRole(tx, input)
  const notes = artifactKindSpecOf(artifact.kind)?.notes
  if (role === null || !notes) throw artifactNotFound()
  if (!artifactRoleAtLeast(role, needed)) throw artifactForbidden()
  return { ...artifact, notes, role }
}

/** The owner's artifact of a kind that takes notes, under its lock, and what they anchor to. */
async function lockNotedArtifact(tx: Prisma.TransactionClient, input: Owner) {
  const artifact = await lockOwnedArtifact(tx, input)
  const notes = artifactKindSpecOf(artifact.kind)?.notes
  if (!notes) throw artifactNotFound()
  return { ...artifact, notes }
}

/** A live block a note anchors to — a section of a document, a row of a table — never an offset. */
const liveAnchors = (artifactId: string, keys: string | { in: string[] }, kind: string) => ({
  documentId: artifactId,
  sectionKey: keys,
  blockKind: kind,
  deletedRev: null,
})

const anchorBlockKind = { quote: 'section', cell: 'row', element: 'html' } as const

/**
 * What the role reads of an anchor in the checked text of its block (the layers keep parsers of
 * Markdown and HTML out of the database package): a quote found exactly once; an element by its id.
 */
export interface ArtifactAnchorReaders {
  quote: (markdown: string, quote: string) => boolean
  element: (input: {
    block: string
    html: string
    id: string
  }) => { tag: string; text: string } | null
}

/** The checked columns of a table: its first `columns` block in order that parses. */
async function checkedColumns(tx: Prisma.TransactionClient, artifactId: string) {
  const blocks = await tx.artifactBlock.findMany({
    where: { documentId: artifactId, blockKind: 'columns', deletedRev: null },
    orderBy: [{ rank: 'asc' }, { sectionKey: 'asc' }],
  })
  return tableOfBlocks(
    blocks.map((block) => ({
      key: block.sectionKey,
      kind: 'columns',
      rev: block.rev,
      content: blockCheckedText(block),
    })),
  ).columns
}

export async function readArtifactComments(db: Db, input: Owner) {
  // The access decision, notes, and checked words must describe the same snapshot.
  return db.$transaction(
    async (tx) => {
      const role = await artifactRole(tx, input)
      if (role === null) throw artifactNotFound()
      // The owner's private notes are theirs alone; a thread of all is seen by all (88.17а).
      const comments = await tx.artifactComment.findMany({
        where: {
          artifactId: input.artifactId,
          OR: [
            { shared: true },
            ...(role === 'owner' ? [{ shared: false, authorUserId: input.userId }] : []),
          ],
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          blockKey: true,
          anchor: true,
          body: true,
          shared: true,
          resolvedAt: true,
          authorUserId: true,
          author: { select: { name: true } },
          replies: {
            where: {
              OR: [
                { authorUserId: input.userId },
                { byAgent: true, pendingAt: null },
                { byAgent: false, thread: { shared: true } },
              ],
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: {
              id: true,
              body: true,
              createdAt: true,
              byAgent: true,
              authorUserId: true,
              author: { select: { name: true } },
            },
          },
        },
      })
      const blocks = await tx.artifactBlock.findMany({
        where: {
          ...liveAnchors(
            input.artifactId,
            { in: [...new Set(comments.map((comment) => comment.blockKey))] },
            'section',
          ),
          blockKind: { in: Object.values(anchorBlockKind) },
        },
      })
      const hasCells = blocks.some((block) => block.blockKind === 'row')
      return {
        comments,
        /** The checked text of each live anchored block (a section, or a row's JSON). */
        blocks: new Map(blocks.map((block) => [block.sectionKey, blockCheckedText(block)])),
        columns: hasCells ? await checkedColumns(tx, input.artifactId) : [],
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

/**
 * The user's own billable chat. The owner's is of the artifact's workspace (88.18в); a recipient's
 * is of their own, one that may take the data of the artifact's (Ар38, 88.17а).
 */
async function requireOwnChat(
  tx: Prisma.TransactionClient,
  input: { taskId: string; userId: string; artifactId: string; artifactWorkspaceId: string },
) {
  const chat = await tx.task.findFirst({
    where: {
      id: input.taskId,
      ...accessibleTasks(input.userId),
      createdById: input.userId,
      billable: true,
    },
    select: { workspaceId: true },
  })
  if (!chat) throw artifactNotFound()
  if (chat.workspaceId === input.artifactWorkspaceId) return
  const role = await artifactRole(tx, input)
  if (
    role === null ||
    role === 'owner' ||
    !(await dataClassesAllow(tx, chat.workspaceId, input.artifactWorkspaceId))
  )
    throw artifactNotFound()
}

/**
 * What a reader may send to an agent and have it answer (88.17а): threads of all from
 * «Комментирует» up, private notes only their owner's own.
 */
const dispatchable = (role: ArtifactRole | null, userId: string) => ({
  OR: [
    ...(role !== null && artifactRoleAtLeast(role, 'comment') ? [{ shared: true }] : []),
    ...(role === 'owner' ? [{ shared: false, authorUserId: userId }] : []),
  ],
})

/** Of these threads, the ones the reader may still send, under the role they have now. */
async function dispatchableThreads(
  tx: Prisma.TransactionClient,
  input: Owner & { threadIds: readonly string[] },
): Promise<Set<string>> {
  const role = await artifactRole(tx, input)
  if (role === null || input.threadIds.length === 0) return new Set()
  const rows = await tx.artifactComment.findMany({
    where: {
      artifactId: input.artifactId,
      id: { in: [...input.threadIds] },
      ...dispatchable(role, input.userId),
    },
    select: { id: true },
  })
  return new Set(rows.map((row) => row.id))
}

async function requireCommentRoom(tx: Prisma.TransactionClient, artifactId: string) {
  const [roots, replies] = await Promise.all([
    tx.artifactComment.count({ where: { artifactId } }),
    tx.artifactCommentReply.count({ where: { thread: { artifactId } } }),
  ])
  if (roots + replies >= artifactLimits.comments) throw artifactLimit('comments')
}

/** What the server stores of a cell: its column's name and text, read from checked blocks. */
async function cellAnchor(
  tx: Prisma.TransactionClient,
  artifactId: string,
  input: ArtifactCellAnchorInput,
  row: string,
): Promise<ArtifactCellAnchor> {
  let value: unknown
  try {
    value = JSON.parse(row) as unknown
  } catch {
    throw artifactStale()
  }
  const cells = artifactCellsSchema.safeParse(value)
  const column = (await checkedColumns(tx, artifactId)).find((each) => each.key === input.column)
  if (!cells.success || !column) throw artifactStale()
  return {
    ...input,
    columnName: column.name,
    text: commentCellText(tableCellText(column, cells.data[column.key])),
  }
}

/** The anchor as stored: a quote as it came, a cell and an element with what the server read. */
async function storedAnchor(
  tx: Prisma.TransactionClient,
  artifactId: string,
  anchor: ArtifactCommentAnchorInput,
  text: string,
  readers: ArtifactAnchorReaders,
): Promise<ArtifactCommentAnchor> {
  switch (anchor.kind) {
    case 'quote':
      return anchor
    case 'cell':
      return cellAnchor(tx, artifactId, anchor, text)
    case 'element': {
      const element = readers.element({ block: anchor.block, html: text, id: anchor.element })
      if (!element) throw artifactStale()
      return { ...anchor, tag: element.tag.slice(0, 32), text: commentCellText(element.text) }
    }
  }
}

export async function addArtifactComment(
  db: Db,
  input: Owner & {
    anchor: ArtifactCommentAnchorInput
    body: string
    /** A thread everyone with access sees (88.17а); absent — the owner's private note. */
    shared?: boolean
    origin?: OriOrigin | null
  },
  readers: ArtifactAnchorReaders,
) {
  return db.$transaction(async (tx) => {
    const shared = input.shared === true
    const { notes } = shared
      ? await lockNotesFor(tx, input, 'comment')
      : await lockNotedArtifact(tx, input)
    const { anchor } = input
    if (anchor.kind !== notes) throw artifactNotFound()
    if (secretInContent(input.body) || (anchor.kind === 'quote' && secretInContent(anchor.quote)))
      throw artifactSecretShape()
    const block = await tx.artifactBlock.findFirst({
      where: liveAnchors(input.artifactId, anchor.block, anchorBlockKind[anchor.kind]),
    })
    const text = block && blockCheckedText(block)
    if (
      block === null ||
      block.pendingTaskId !== null ||
      block.rev !== anchor.rev ||
      text === null ||
      (anchor.kind === 'quote' && !readers.quote(text, anchor.quote))
    )
      throw artifactStale()
    const stored = await storedAnchor(tx, input.artifactId, anchor, text, readers)
    if (stored.kind !== 'quote' && secretInContent(stored.text)) throw artifactSecretShape()
    await requireCommentRoom(tx, input.artifactId)
    const created = await tx.artifactComment.create({
      data: {
        artifactId: input.artifactId,
        authorUserId: input.userId,
        blockKey: anchor.block,
        anchor: stored,
        body: input.body,
        shared,
      },
      select: { id: true },
    })
    // A thread of all is a message between users (Ар56): kept in full 6 months; everyone else with
    // access is told of it, without its words (Ар54).
    if (shared)
      await recordOriComment(tx, {
        artifactId: input.artifactId,
        userId: input.userId,
        origin: input.origin ?? null,
        body: input.body,
        key: created.id,
      })
    return created
  })
}

export async function addArtifactCommentReply(
  db: Db,
  input: Owner & { threadId: string; requestId: string; body: string; origin?: OriOrigin | null },
) {
  return db.$transaction(async (tx) => {
    const { role } = await lockNotesFor(tx, input, 'view')
    const thread = await tx.artifactComment.findFirst({
      where: { artifactId: input.artifactId, id: input.threadId },
      select: { resolvedAt: true, shared: true, authorUserId: true },
    })
    // A private note answers only its owner; a thread of all — anyone who comments (88.17а).
    const allowed = thread?.shared
      ? artifactRoleAtLeast(role, 'comment')
      : role === 'owner' && thread?.authorUserId === input.userId
    if (!thread || !allowed) throw artifactCommentUnavailable()
    const key = { threadId: input.threadId, requestId: input.requestId }
    const existing = await tx.artifactCommentReply.findUnique({
      where: { threadId_requestId: key },
      select: { id: true, body: true, authorUserId: true },
    })
    if (existing) {
      if (existing.authorUserId !== input.userId) throw artifactCommentUnavailable()
      if (existing.body !== input.body) throw artifactOpReused(input.requestId)
      return { id: existing.id }
    }
    if (thread.resolvedAt !== null) throw artifactCommentUnavailable()
    if (secretInContent(input.body)) throw artifactSecretShape()
    await requireCommentRoom(tx, input.artifactId)
    const reply = await tx.artifactCommentReply.create({
      data: { ...key, authorUserId: input.userId, body: input.body },
      select: { id: true },
    })
    if (thread.shared)
      await recordOriComment(tx, {
        artifactId: input.artifactId,
        userId: input.userId,
        origin: input.origin ?? null,
        body: input.body,
        key: reply.id,
      })
    return reply
  })
}

const {
  threads: dispatchMaxThreads,
  entries: dispatchMaxEntries,
  bytes: dispatchMaxBytes,
} = artifactCommentDispatchLimits

/**
 * The reader explicitly chose these threads, not everything a chat can read: the owner's private
 * notes, and threads of all from «Комментирует» up (88.17а). Words of other people are marked
 * `by: "other"` — the agent never takes them for the client's (Ар25). The artifact lock orders the
 * snapshot with replies and changes in the state of a thread. `workspaceId` is the chat's.
 */
export async function snapshotArtifactComments(
  tx: Prisma.TransactionClient,
  input: Owner & { workspaceId: string; threadIds: readonly string[] },
) {
  const artifact = await lockNotesFor(tx, input, 'view')
  if (
    input.workspaceId !== artifact.workspaceId &&
    (artifact.role === 'owner' ||
      !(await dataClassesAllow(tx, input.workspaceId, artifact.workspaceId)))
  )
    throw artifactNotFound()
  if (input.threadIds.length === 0 || input.threadIds.length > dispatchMaxThreads)
    throw artifactCommentDispatchTooLarge()
  const roots = await tx.artifactComment.findMany({
    where: {
      artifactId: input.artifactId,
      id: { in: [...input.threadIds] },
      resolvedAt: null,
      ...dispatchable(artifact.role, input.userId),
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      anchor: true,
      body: true,
      authorUserId: true,
      replies: {
        // People's replies: the reader's own, and everyone's in a thread of all.
        where: {
          byAgent: false,
          OR: [{ authorUserId: input.userId }, { thread: { shared: true } }],
        },
        orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
        select: { body: true, authorUserId: true },
        take: dispatchMaxEntries,
      },
    },
  })
  if (roots.length !== input.threadIds.length) throw artifactCommentUnavailable()
  const own = (authorUserId: string | null) => authorUserId === input.userId
  const snapshot = roots.map(({ id, anchor, body, authorUserId, replies }) => ({
    id,
    anchor,
    body,
    ...(own(authorUserId) ? {} : { by: 'other' as const }),
    replies: replies.map((reply) =>
      own(reply.authorUserId) ? reply.body : { body: reply.body, by: 'other' as const },
    ),
  }))
  if (
    roots.reduce((count, root) => count + 1 + root.replies.length, 0) > dispatchMaxEntries ||
    Buffer.byteLength(JSON.stringify(snapshot)) > dispatchMaxBytes
  )
    throw artifactCommentDispatchTooLarge()
  const checked = artifactCommentSnapshotSchema.safeParse(snapshot)
  if (!checked.success) throw artifactCommentUnavailable()
  return checked.data
}

/** Read one explicit snapshot under current access, never the live thread or chat history. */
export function readArtifactCommentDispatch(
  db: Db,
  input: { taskId: string; requestEventId: bigint; authorId: string },
) {
  return db.$transaction(
    async (tx) => {
      const row = await tx.artifactCommentDispatch.findUnique({
        where: { requestEventId: input.requestEventId },
        select: {
          userId: true,
          artifactId: true,
          notes: true,
          artifact: { select: { workspaceId: true } },
          request: { select: { taskId: true, type: true } },
        },
      })
      if (
        !row ||
        row.userId !== input.authorId ||
        row.request.taskId !== input.taskId ||
        row.request.type !== 'feed.request'
      )
        throw artifactNotFound()
      await requireOwnChat(tx, {
        taskId: input.taskId,
        userId: row.userId,
        artifactId: row.artifactId,
        artifactWorkspaceId: row.artifact.workspaceId,
      })
      if (Buffer.byteLength(JSON.stringify(row.notes)) > dispatchMaxBytes)
        throw artifactCommentUnavailable()
      const notes = artifactCommentSnapshotSchema.safeParse(row.notes)
      if (!notes.success) throw artifactCommentUnavailable()
      // Under the access of now: a thread the sender may no longer send is left out.
      const allowed = await dispatchableThreads(tx, {
        artifactId: row.artifactId,
        userId: row.userId,
        threadIds: notes.data.map((note) => note.id),
      })
      const kept = notes.data.filter((note) => allowed.has(note.id))
      if (kept.length === 0) throw artifactNotFound()
      return { artifactId: row.artifactId, notes: kept }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

export async function resolveArtifactComment(
  db: Db,
  input: Owner & { commentId: string; resolved: boolean },
) {
  return db.$transaction(async (tx) => {
    const { role } = await lockNotesFor(tx, input, 'view')
    const where = { artifactId: input.artifactId, id: input.commentId }
    const comment = await tx.artifactComment.findFirst({
      where,
      select: { resolvedAt: true, shared: true, authorUserId: true },
    })
    // A thread of all is closed by its author or the owner; a private note by its owner (88.17а).
    const allowed =
      comment !== null &&
      (comment.shared
        ? role === 'owner' ||
          (artifactRoleAtLeast(role, 'comment') && comment.authorUserId === input.userId)
        : role === 'owner' && comment.authorUserId === input.userId)
    if (!allowed) throw artifactNotFound()
    if ((comment.resolvedAt !== null) !== input.resolved)
      await tx.artifactComment.updateMany({
        where,
        data: { resolvedAt: input.resolved ? new Date() : null },
      })
  })
}

// ———————————————————————————————— the agent's side (88.18г, §7.5)

type AgentTurn = { taskId: string; turnNo: number }

/** The chat's author: the one who sent it the threads, whose chat it must be. */
async function chatAuthorOf(tx: Prisma.TransactionClient, taskId: string) {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { createdById: true },
  })
  if (!task?.createdById) throw artifactNotFound()
  return task.createdById
}

/** A chat sees a thread only while one of its requests carried it (88.18в) and its sender may. */
const sentToChat = (taskId: string, userId: string, threadId: string) => ({
  userId,
  request: { taskId },
  notes: { array_contains: [{ id: threadId }] },
})

const maxChatNotes = 50

/**
 * `artifact_comments`: the threads the client sent to this chat, latest snapshot first, with their
 * state now and this chat's replies. Replies written after a dispatch never come here.
 */
export function readChatArtifactComments(db: Db, input: { taskId: string; artifactId?: string }) {
  return db.$transaction(
    async (tx) => {
      const userId = await chatAuthorOf(tx, input.taskId)
      const dispatches = await tx.artifactCommentDispatch.findMany({
        where: {
          userId,
          request: { taskId: input.taskId },
          ...(input.artifactId === undefined ? {} : { artifactId: input.artifactId }),
        },
        orderBy: { requestEventId: 'desc' },
        take: 20,
        select: { artifactId: true, notes: true, artifact: { select: { workspaceId: true } } },
      })
      const notes = new Map<string, { artifactId: string; note: ArtifactCommentSnapshot[number] }>()
      const open = new Map<string, boolean>()
      for (const dispatch of dispatches) {
        if (!open.has(dispatch.artifactId)) {
          let allowed = true
          try {
            await requireOwnChat(tx, {
              taskId: input.taskId,
              userId,
              artifactId: dispatch.artifactId,
              artifactWorkspaceId: dispatch.artifact.workspaceId,
            })
          } catch {
            allowed = false
          }
          open.set(dispatch.artifactId, allowed)
        }
        if (!open.get(dispatch.artifactId)) continue
        const parsed = artifactCommentSnapshotSchema.safeParse(dispatch.notes)
        if (!parsed.success) continue
        for (const note of parsed.data)
          if (!notes.has(note.id) && notes.size < maxChatNotes)
            notes.set(note.id, { artifactId: dispatch.artifactId, note })
      }
      const allowed = new Set<string>()
      for (const artifactId of new Set([...notes.values()].map((each) => each.artifactId))) {
        const threadIds = [...notes.values()]
          .filter((each) => each.artifactId === artifactId)
          .map((each) => each.note.id)
        for (const id of await dispatchableThreads(tx, { artifactId, userId, threadIds }))
          allowed.add(id)
      }
      const live = await tx.artifactComment.findMany({
        where: { id: { in: [...allowed] } },
        select: {
          id: true,
          resolvedAt: true,
          replies: {
            where: { byAgent: true, authorTaskId: input.taskId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, body: true, pendingAt: true },
          },
        },
      })
      const liveOf = new Map(live.map((row) => [row.id, row]))
      return [...notes.values()].flatMap(({ artifactId, note }) => {
        const row = liveOf.get(note.id)
        if (!row) return []
        return [
          {
            threadId: note.id,
            artifactId,
            anchor: note.anchor,
            body: note.body,
            ...(note.by === undefined ? {} : { by: note.by }),
            replies: note.replies,
            resolved: row.resolvedAt !== null,
            yourReplies: row.replies.map((reply) => ({
              id: reply.id,
              body: reply.body,
              checking: reply.pendingAt !== null,
            })),
          },
        ]
      })
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

/**
 * `artifact_reply`: a reply of the agent in an open thread sent to its chat. It waits for the check
 * of core (§7.3); people see it, and the thread closes if asked, only once it passes. Only one who
 * may close a thread — its author or the owner — has it closed by their agent (88.17а).
 */
export async function addAgentCommentReply(
  db: Db,
  input: AgentTurn & {
    threadId: string
    requestId: string
    body: string
    resolve: boolean
    now: Date
  },
) {
  return db.$transaction(async (tx) => {
    const userId = await chatAuthorOf(tx, input.taskId)
    const thread = await tx.artifactComment.findUnique({
      where: { id: input.threadId },
      select: { artifactId: true, authorUserId: true },
    })
    if (!thread) throw artifactCommentUnavailable()
    const reader = { artifactId: thread.artifactId, userId }
    let artifact
    try {
      artifact = await lockNotesFor(tx, reader, 'view')
    } catch {
      throw artifactCommentUnavailable()
    }
    await requireOwnChat(tx, {
      taskId: input.taskId,
      userId,
      artifactId: thread.artifactId,
      artifactWorkspaceId: artifact.workspaceId,
    })
    const may = await dispatchableThreads(tx, { ...reader, threadIds: [input.threadId] })
    if (!may.has(input.threadId)) throw artifactCommentUnavailable()
    if (input.resolve && artifact.role !== 'owner' && thread.authorUserId !== userId)
      throw artifactForbidden()
    const sent = await tx.artifactCommentDispatch.findFirst({
      where: { artifactId: thread.artifactId, ...sentToChat(input.taskId, userId, input.threadId) },
      select: { requestEventId: true },
    })
    if (!sent) throw artifactCommentUnavailable()
    const key = { threadId: input.threadId, requestId: input.requestId }
    const existing = await tx.artifactCommentReply.findUnique({
      where: { threadId_requestId: key },
      select: { id: true, body: true, authorTaskId: true, resolveOnPass: true },
    })
    if (existing) {
      if (existing.authorTaskId !== input.taskId) throw artifactCommentUnavailable()
      if (existing.body !== input.body || existing.resolveOnPass !== input.resolve)
        throw artifactOpReused(input.requestId)
      return { id: existing.id, artifactId: thread.artifactId, repeated: true }
    }
    const state = await tx.artifactComment.findUniqueOrThrow({
      where: { id: input.threadId },
      select: { resolvedAt: true },
    })
    if (state.resolvedAt !== null) throw artifactCommentUnavailable()
    if (secretInContent(input.body)) throw artifactSecretShape()
    if (
      !(await admitInWindow(tx, {
        key: `artifact-reply:${thread.artifactId}`,
        limit: artifactLimits.agentRepliesPerHour,
        windowMs: 60 * 60 * 1000,
        now: input.now.getTime(),
      }))
    )
      throw artifactLimit('agentRepliesPerHour')
    await requireCommentRoom(tx, thread.artifactId)
    const reply = await tx.artifactCommentReply.create({
      data: {
        ...key,
        byAgent: true,
        authorTaskId: input.taskId,
        authorTurnNo: input.turnNo,
        body: input.body,
        pendingAt: input.now,
        resolveOnPass: input.resolve,
      },
      select: { id: true },
    })
    return { id: reply.id, artifactId: thread.artifactId, repeated: false }
  })
}

/** The replies of the chat that wait for the check. */
export function pendingAgentCommentReplies(
  db: Pick<PrismaClient, 'artifactCommentReply'>,
  taskId: string,
) {
  return db.artifactCommentReply.findMany({
    where: { authorTaskId: taskId, pendingAt: { not: null } },
    orderBy: { id: 'asc' },
    select: { id: true, body: true, thread: { select: { artifactId: true } } },
  })
}

/**
 * What core decided of the chat's replies: one that passed is shown and closes its note if asked;
 * a refused one is deleted with its text. One whose sender may no longer send the thread — or
 * close it, when asked — is dropped as refused: access is read again now (88.17в). Returns the
 * counts.
 */
export async function settleAgentCommentReplies(
  db: Db,
  input: { taskId: string; verdicts: readonly { id: string; refused: boolean }[]; now: Date },
) {
  let checked = 0
  let refused = 0
  for (const verdict of input.verdicts) {
    await db.$transaction(async (tx) => {
      const where = { id: verdict.id, authorTaskId: input.taskId, pendingAt: { not: null } }
      if (verdict.refused) {
        refused += (await tx.artifactCommentReply.deleteMany({ where })).count
        return
      }
      const reply = await tx.artifactCommentReply.findFirst({
        where,
        select: {
          threadId: true,
          resolveOnPass: true,
          body: true,
          thread: { select: { artifactId: true, shared: true, authorUserId: true } },
        },
      })
      if (!reply) return
      const { thread } = reply
      const sender = (
        await tx.task.findUnique({ where: { id: input.taskId }, select: { createdById: true } })
      )?.createdById
      if (!sender || !(await senderMayStill(tx, { taskId: input.taskId, sender, reply }))) {
        refused += (await tx.artifactCommentReply.deleteMany({ where })).count
        return
      }
      await tx.artifactCommentReply.updateMany({ where, data: { pendingAt: null } })
      if (reply.resolveOnPass)
        await tx.artifactComment.updateMany({
          where: { id: reply.threadId, resolvedAt: null },
          data: { resolvedAt: input.now },
        })
      // Who sent the thread is told the agent answered (Ар54); the words are not said. In a thread of
      // all the reply is a message to the others, written for the sender (Ар56, 88.17а).
      {
        await enqueueArtifactNotify(
          tx,
          {
            artifactId: thread.artifactId,
            userId: sender,
            kind: 'artifact_agent_reply',
            actorUserId: null,
          },
          verdict.id,
        )
        if (thread.shared)
          await recordOriComment(tx, {
            artifactId: thread.artifactId,
            userId: sender,
            origin: null,
            body: reply.body,
            key: verdict.id,
          })
      }
      checked += 1
    })
  }
  return { checked, refused }
}

/** Whether the sender of a thread may still have their agent's reply shown, and close it if asked. */
async function senderMayStill(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string
    sender: string
    reply: {
      threadId: string
      resolveOnPass: boolean
      thread: { artifactId: string; authorUserId: string | null }
    }
  },
): Promise<boolean> {
  const { artifactId, authorUserId } = input.reply.thread
  const reader = { artifactId, userId: input.sender }
  const artifact = await lockArtifact(tx, artifactId)
  try {
    await requireOwnChat(tx, {
      taskId: input.taskId,
      userId: input.sender,
      artifactId,
      artifactWorkspaceId: artifact.workspaceId,
    })
  } catch {
    return false
  }
  const may = await dispatchableThreads(tx, { ...reader, threadIds: [input.reply.threadId] })
  if (!may.has(input.reply.threadId)) return false
  return (
    !input.reply.resolveOnPass ||
    authorUserId === input.sender ||
    (await artifactRole(tx, reader)) === 'owner'
  )
}

/** The mark of a turn that read words of other people (Ар25): it writes to no unnamed shared one. */
export async function markArtifactReadOther(
  db: Parameters<typeof admitInWindow>[0],
  input: { taskId: string; turnNo: number; now: number },
) {
  await admitInWindow(db, {
    key: `artifact-read-other:${input.taskId}:${input.turnNo}`,
    limit: 1_000_000,
    windowMs: 24 * 60 * 60 * 1000,
    now: input.now,
  })
}

/** A failed or cancelled turn's replies nobody will check: dropped (Ар16). */
export async function dropAgentCommentReplies(
  db: Pick<PrismaClient, 'artifactCommentReply'>,
  taskId: string,
): Promise<number> {
  return (
    await db.artifactCommentReply.deleteMany({
      where: { authorTaskId: taskId, pendingAt: { not: null } },
    })
  ).count
}

/**
 * The collector: unchecked replies older than `before` of chats whose pass is over, or gone. A chat
 * the caller still runs (`busy`) keeps them, as the collector of blocks does (Ар16).
 */
export async function dropStaleAgentCommentReplies(
  db: Pick<PrismaClient, '$queryRaw' | '$executeRaw'>,
  before: Date,
  busy: (taskId: string) => boolean = () => false,
): Promise<number> {
  const rows = await db.$queryRaw<{ task_id: string | null }[]>`
    SELECT DISTINCT r.author_task_id AS task_id FROM artifact_comment_replies r
    WHERE r.pending_at IS NOT NULL AND r.pending_at < ${before}
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.id = r.author_task_id AND t.status::text IN ('preparing', 'running'))
    LIMIT 50`
  const gone = rows.some((row) => row.task_id === null)
  const idle = rows.flatMap((row) => (row.task_id && !busy(row.task_id) ? [row.task_id] : []))
  if (!gone && idle.length === 0) return 0
  return db.$executeRaw`
    DELETE FROM artifact_comment_replies r
    WHERE r.pending_at IS NOT NULL AND r.pending_at < ${before}
      AND (r.author_task_id = ANY(${idle}::uuid[]) OR (${gone} AND r.author_task_id IS NULL))
      AND NOT EXISTS (
        SELECT 1 FROM tasks t
        WHERE t.id = r.author_task_id AND t.status::text IN ('preparing', 'running'))`
}

/** A comment or a reply in a thread of all: a message and a fact (Ар56, 88.17а). */
async function recordOriComment(
  tx: Prisma.TransactionClient,
  input: {
    artifactId: string
    userId: string
    origin: OriOrigin | null
    body: string
    key: string
  },
) {
  const { owner, others } = await artifactAddressees(tx, input.artifactId)
  const addressees = [owner, ...others].filter(
    (id): id is string => id !== null && id !== input.userId,
  )
  if (addressees.length === 0) return
  const keepUntil = new Date(Date.now() + oriTerms.messagesDays * 24 * 60 * 60 * 1000)
  await tx.$executeRaw`
    INSERT INTO ori_messages (artifact_id, user_id, kind, content, addressees, keep_until)
    VALUES (${input.artifactId}::uuid, ${input.userId}::uuid, 'comment', ${input.body},
            ${addressees}::uuid[], ${keepUntil})`
  await recordOriFact(tx, {
    kind: 'artifact_comment',
    userId: input.userId,
    origin: input.origin,
    artifactId: input.artifactId,
    addressees,
  })
  for (const userId of addressees)
    await enqueueArtifactNotify(
      tx,
      { artifactId: input.artifactId, userId, kind: 'artifact_comment', actorUserId: input.userId },
      input.key,
    )
}
