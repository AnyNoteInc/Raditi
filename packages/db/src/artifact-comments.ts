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
  type ArtifactQuoteAnchor,
} from '@repo/domain/artifacts'

import { artifactRole, lockArtifact } from './artifacts.ts'
import type { Prisma, PrismaClient } from './generated/prisma/client.ts'
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
            where: { authorUserId: input.userId },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            select: { id: true, body: true, createdAt: true },
          },
        },
      })
      const blocks = await tx.artifactBlock.findMany({
        where: {
          documentId: input.artifactId,
          sectionKey: { in: [...new Set(comments.map((comment) => comment.blockKey))] },
          blockKind: 'section',
          deletedRev: null,
        },
      })
      return {
        comments,
        sections: new Map(blocks.map((block) => [block.sectionKey, blockCheckedText(block)])),
      }
    },
    { isolationLevel: 'RepeatableRead' },
  )
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

export async function addArtifactComment(
  db: Db,
  input: Owner & { anchor: ArtifactQuoteAnchor; body: string },
  validateQuote: (markdown: string, quote: string) => boolean,
) {
  return db.$transaction(async (tx) => {
    const artifact = await lockOwnedArtifact(tx, input)
    if (!artifactKindSpecOf(artifact.kind)?.quoteNotes) throw artifactNotFound()
    if (secretInContent(input.body) || secretInContent(input.anchor.quote))
      throw artifactSecretShape()
    const block = await tx.artifactBlock.findFirst({
      where: {
        documentId: input.artifactId,
        sectionKey: input.anchor.block,
        blockKind: 'section',
        deletedRev: null,
      },
    })
    const text = block && blockCheckedText(block)
    if (
      block === null ||
      block.pendingTaskId !== null ||
      block.rev !== input.anchor.rev ||
      text === null ||
      !validateQuote(text, input.anchor.quote)
    )
      throw artifactStale()
    await requireCommentRoom(tx, input.artifactId)
    return tx.artifactComment.create({
      data: {
        artifactId: input.artifactId,
        authorUserId: input.userId,
        blockKey: input.anchor.block,
        anchor: input.anchor,
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
    const artifact = await lockOwnedArtifact(tx, input)
    if (!artifactKindSpecOf(artifact.kind)?.quoteNotes) throw artifactNotFound()
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
  const artifact = await lockOwnedArtifact(tx, input)
  if (artifact.workspaceId !== input.workspaceId || !artifactKindSpecOf(artifact.kind)?.quoteNotes)
    throw artifactNotFound()
  if (input.threadIds.length === 0 || input.threadIds.length > dispatchMaxThreads)
    throw artifactCommentDispatchTooLarge()
  const roots = await tx.artifactComment.findMany({
    where: { ...authoredBy(input), id: { in: [...input.threadIds] }, resolvedAt: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      anchor: true,
      body: true,
      replies: {
        where: { authorUserId: input.userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { body: true },
        take: dispatchMaxEntries,
      },
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
      const chat = await tx.task.findFirst({
        where: {
          id: input.taskId,
          workspaceId: row.artifact.workspaceId,
          createdById: row.userId,
          billable: true,
          deletedAt: null,
          workspace: { members: { some: { userId: row.userId } } },
          OR: [{ projectId: null }, { project: { deletedAt: null, createdById: row.userId } }],
        },
        select: { id: true },
      })
      if (!chat) throw artifactNotFound()
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
