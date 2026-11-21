import { secretInContent } from '@repo/domain'
import {
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
