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
} from '@repo/domain/artifacts'

import { artifactRole, lockArtifact } from './artifacts.ts'
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

const anchorBlockKind = { quote: 'section', cell: 'row' } as const

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

/** A note shows only its author's replies, oldest first. */
const ownReplies = <S extends Prisma.ArtifactCommentReplySelect>(userId: string, select: S) => ({
  where: { authorUserId: userId },
  orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  select,
})

export async function readArtifactComments(db: Db, input: Owner) {
  // The access decision, notes, and checked words must describe the same snapshot.
  return db.$transaction(
    async (tx) => {
      await requireOwner(tx, input)
      const comments = await tx.artifactComment.findMany({
        where: authoredBy(input),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          blockKey: true,
          anchor: true,
          body: true,
          resolvedAt: true,
          replies: {
            where: {
              OR: [{ authorUserId: input.userId }, { byAgent: true, pendingAt: null }],
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, body: true, createdAt: true, byAgent: true },
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

/** The user's own billable chat they may still open, in the artifact's workspace. */
async function requireOwnChat(
  tx: Prisma.TransactionClient,
  input: { taskId: string; userId: string; workspaceId: string },
) {
  const chat = await tx.task.findFirst({
    where: {
      id: input.taskId,
      ...accessibleTasks(input.userId),
      workspaceId: input.workspaceId,
      createdById: input.userId,
      billable: true,
    },
    select: { id: true },
  })
  if (!chat) throw artifactNotFound()
}

const authoredBy = (input: Owner) => ({
  artifactId: input.artifactId,
  authorUserId: input.userId,
})

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

export async function addArtifactComment(
  db: Db,
  input: Owner & { anchor: ArtifactCommentAnchorInput; body: string },
  validateQuote: (markdown: string, quote: string) => boolean,
) {
  return db.$transaction(async (tx) => {
    const { notes } = await lockNotedArtifact(tx, input)
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
      (anchor.kind === 'quote' && !validateQuote(text, anchor.quote))
    )
      throw artifactStale()
    const stored: ArtifactCommentAnchor =
      anchor.kind === 'quote' ? anchor : await cellAnchor(tx, input.artifactId, anchor, text)
    if (stored.kind === 'cell' && secretInContent(stored.text)) throw artifactSecretShape()
    await requireCommentRoom(tx, input.artifactId)
    return tx.artifactComment.create({
      data: {
        artifactId: input.artifactId,
        authorUserId: input.userId,
        blockKey: anchor.block,
        anchor: stored,
        body: input.body,
      },
      select: { id: true },
    })
  })
}

export async function addArtifactCommentReply(
  db: Db,
  input: Owner & { threadId: string; requestId: string; body: string },
) {
  return db.$transaction(async (tx) => {
    await lockNotedArtifact(tx, input)
    const thread = await tx.artifactComment.findFirst({
      where: { ...authoredBy(input), id: input.threadId },
      select: { resolvedAt: true },
    })
    if (!thread) throw artifactCommentUnavailable()
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
    return tx.artifactCommentReply.create({
      data: { ...key, authorUserId: input.userId, body: input.body },
      select: { id: true },
    })
  })
}

const {
  threads: dispatchMaxThreads,
  entries: dispatchMaxEntries,
  bytes: dispatchMaxBytes,
} = artifactCommentDispatchLimits

/** The owner explicitly chose these notes, not everything a chat can read. The artifact lock
 * orders the snapshot with private replies and changes in the state of a note. */
export async function snapshotArtifactComments(
  tx: Prisma.TransactionClient,
  input: Owner & { workspaceId: string; threadIds: readonly string[] },
) {
  const artifact = await lockNotedArtifact(tx, input)
  if (artifact.workspaceId !== input.workspaceId) throw artifactNotFound()
  if (input.threadIds.length === 0 || input.threadIds.length > dispatchMaxThreads)
    throw artifactCommentDispatchTooLarge()
  const roots = await tx.artifactComment.findMany({
    where: { ...authoredBy(input), id: { in: [...input.threadIds] }, resolvedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      anchor: true,
      body: true,
      replies: { ...ownReplies(input.userId, { body: true }), take: dispatchMaxEntries },
    },
  })
  if (roots.length !== input.threadIds.length) throw artifactCommentUnavailable()
  const snapshot = roots.map(({ id, anchor, body, replies }) => ({
    id,
    anchor,
    body,
    replies: replies.map((reply) => reply.body),
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
        workspaceId: row.artifact.workspaceId,
      })
      await requireOwner(tx, row)
      if (Buffer.byteLength(JSON.stringify(row.notes)) > dispatchMaxBytes)
        throw artifactCommentUnavailable()
      const notes = artifactCommentSnapshotSchema.safeParse(row.notes)
      if (!notes.success) throw artifactCommentUnavailable()
      return { artifactId: row.artifactId, notes: notes.data }
    },
    { isolationLevel: 'RepeatableRead' },
  )
}

export async function resolveArtifactComment(
  db: Db,
  input: Owner & { commentId: string; resolved: boolean },
) {
  return db.$transaction(async (tx) => {
    await lockOwnedArtifact(tx, input)
    const where = { ...authoredBy(input), id: input.commentId }
    const comment = await tx.artifactComment.findFirst({ where, select: { resolvedAt: true } })
    if (comment === null) throw artifactNotFound()
    if ((comment.resolvedAt !== null) !== input.resolved)
      await tx.artifactComment.updateMany({
        where,
        data: { resolvedAt: input.resolved ? new Date() : null },
      })
  })
}

// ———————————————————————————————— the agent's side (88.18г, §7.5)

type AgentTurn = { taskId: string; turnNo: number }

/** The chat and its author: the notes of an artifact are its owner's, the chat must be theirs. */
async function chatAuthorOf(tx: Prisma.TransactionClient, taskId: string) {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { createdById: true },
  })
  if (!task?.createdById) throw artifactNotFound()
  return task.createdById
}

/** A chat sees a note only while one of its requests carried it (88.18в) and the owner owns it. */
const sentToChat = (taskId: string, userId: string, threadId: string) => ({
  userId,
  request: { taskId },
  notes: { array_contains: [{ id: threadId }] },
})

const maxChatNotes = 50

/**
 * `artifact_comments`: the notes the owner sent to this chat, latest snapshot first, with their
 * state now and this chat's replies. The owner's replies written after a dispatch never come here.
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
              workspaceId: dispatch.artifact.workspaceId,
            })
            await requireOwner(tx, { artifactId: dispatch.artifactId, userId })
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
      const live = await tx.artifactComment.findMany({
        where: { id: { in: [...notes.keys()] }, authorUserId: userId },
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
            ownerReplies: note.replies,
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
 * `artifact_reply`: a reply of the agent in an open note sent to its chat. It waits for the check of
 * core (§7.3); the owner sees it, and the note closes if asked, only once it passes.
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
    const thread = await tx.artifactComment.findFirst({
      where: { id: input.threadId, authorUserId: userId },
      select: { artifactId: true },
    })
    if (!thread) throw artifactCommentUnavailable()
    const owner = { artifactId: thread.artifactId, userId }
    const artifact = await lockNotedArtifact(tx, owner)
    await requireOwnChat(tx, { taskId: input.taskId, userId, workspaceId: artifact.workspaceId })
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
 * a refused one is deleted with its text. Returns the counts.
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
        select: { threadId: true, resolveOnPass: true },
      })
      if (!reply) return
      await tx.artifactCommentReply.updateMany({ where, data: { pendingAt: null } })
      if (reply.resolveOnPass)
        await tx.artifactComment.updateMany({
          where: { id: reply.threadId, resolvedAt: null },
          data: { resolvedAt: input.now },
        })
      checked += 1
    })
  }
  return { checked, refused }
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
