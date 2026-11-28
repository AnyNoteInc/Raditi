import { createHash, randomBytes, randomUUID } from 'node:crypto'

import { enqueueOutbox, Prisma, type PrismaClient } from '@repo/db'
import {
  signVkConfirmToken,
  VK_CONFIRM_TTL_SECONDS,
  vkAlreadyPublished,
  vkCommunityNotFound,
  vkJobNames,
  vkKeyInvalid,
  vkLimits,
  vkProposalPayloadSchema,
  vkPublicationLimit,
  vkPublishAtPassed,
  vkPublishAtProblem,
  type VkConfirmMac,
} from '@repo/domain'

import { accessibleTask, isManagerRole, memberRole, taskNotFound } from './chat/access.ts'
import { WRITE } from './chat/dialog-lock.ts'
import { builtinMcpNotAllowed, builtinMcpUnavailable } from './builtin-mcp.ts'

// The press of «Опубликовать» on a card of VK (docs/plan/99-vk-community.md, §3.3, rule 4): web
// checks who presses — the chat is theirs to see, and they manage its workspace —, signs the press
// by VK_CONFIRM_SECRET and writes one row of `vk_actions` that holds the token, with the job of core
// in the outbox, in one transaction. Core checks the token again before it calls VK. The text is the
// one on the card, maybe edited by the client: the token names it by its hash.

const DAY_MS = 24 * 60 * 60_000
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

export async function publishVkProposal(
  db: PrismaClient,
  mac: VkConfirmMac | null | undefined,
  input: { userId: string; reservedId: string; text: string; now?: Date },
): Promise<{ actionId: string }> {
  if (!mac) throw builtinMcpUnavailable()
  const now = input.now ?? new Date()
  const reservation = await db.vkReservation.findFirst({
    where: { id: input.reservedId, outcome: 'done' },
    select: {
      id: true,
      workspaceId: true,
      taskId: true,
      communityId: true,
      payload: true,
    },
  })
  if (reservation === null) throw taskNotFound()
  // The chat is the presser's to see, and they manage the workspace whose community it speaks for.
  const task = await db.task.findFirst({
    where: accessibleTask(input.userId, reservation.taskId),
    select: { id: true },
  })
  if (task === null) throw taskNotFound()
  if (!isManagerRole(await memberRole(db, reservation.workspaceId, input.userId)))
    throw builtinMcpNotAllowed()
  const community = await db.vkCommunity.findFirst({
    where: { id: reservation.communityId, workspaceId: reservation.workspaceId },
    select: { state: true },
  })
  if (community === null) throw vkCommunityNotFound()
  if (community.state !== 'ok') throw vkKeyInvalid()
  const kept = vkProposalPayloadSchema.parse(reservation.payload)
  // The text of the card, as the client left it; the rest of the proposal is the agent's.
  const payload = vkProposalPayloadSchema.parse({ ...kept, text: input.text })
  const publishAt = payload.kind === 'post' ? payload.publishAt : null
  if (publishAt !== null && vkPublishAtProblem(new Date(publishAt), now) !== null)
    throw vkPublishAtPassed()
  const claims = {
    kind: payload.kind,
    userId: input.userId,
    workspaceId: reservation.workspaceId,
    communityId: reservation.communityId,
    reservationId: reservation.id,
    taskId: reservation.taskId,
    textSha256: sha256(payload.text),
    publishAt,
    nonce: randomBytes(16).toString('hex'),
    expiresAt: Math.floor(now.getTime() / 1000) + VK_CONFIRM_TTL_SECONDS,
  }
  const token = signVkConfirmToken(claims, mac)
  const tokenSha256 = sha256(token)
  try {
    return await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`vk-publish:${reservation.workspaceId}`}, 0))`
      if ((await tx.vkAction.count({ where: { reservationId: reservation.id } })) > 0)
        throw vkAlreadyPublished()
      const today = await tx.vkAction.count({
        where: {
          workspaceId: reservation.workspaceId,
          createdAt: { gt: new Date(now.getTime() - DAY_MS) },
          state: { in: ['queued', 'running', 'done', 'lost'] },
        },
      })
      if (today >= vkLimits.publicationsPerDay) throw vkPublicationLimit()
      const actionId = randomUUID()
      await tx.vkAction.create({
        data: {
          id: actionId,
          workspaceId: reservation.workspaceId,
          taskId: reservation.taskId,
          communityId: reservation.communityId,
          reservationId: reservation.id,
          createdById: input.userId,
          kind: payload.kind,
          args: { token, text: payload.text },
          tokenSha256,
        },
      })
      await enqueueOutbox(tx, {
        topic: 'vk',
        type: vkJobNames.action,
        payload: { actionId },
        dedupeKey: `vk.action:${actionId}`,
      })
      return { actionId }
    }, WRITE)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
      throw vkAlreadyPublished()
    throw error
  }
}
