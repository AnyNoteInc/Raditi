import { secretInContent } from '@repo/domain'
import {
  artifactKindSpecOf,
  artifactLimit,
  artifactLimits,
  artifactNotFound,
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
        where: { artifactId: input.artifactId, authorUserId: input.userId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: { id: true, blockKey: true, anchor: true, body: true, resolvedAt: true },
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
    const count = await tx.artifactComment.count({ where: { artifactId: input.artifactId } })
    if (count >= artifactLimits.comments) throw artifactLimit('comments')
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

export async function resolveArtifactComment(
  db: Db,
  input: Owner & { commentId: string; resolved: boolean },
) {
  return db.$transaction(async (tx) => {
    await lockOwnedArtifact(tx, input)
    const where = { id: input.commentId, artifactId: input.artifactId, authorUserId: input.userId }
    const comment = await tx.artifactComment.findFirst({ where, select: { resolvedAt: true } })
    if (comment === null) throw artifactNotFound()
    if ((comment.resolvedAt !== null) !== input.resolved)
      await tx.artifactComment.updateMany({
        where,
        data: { resolvedAt: input.resolved ? new Date() : null },
      })
  })
}
