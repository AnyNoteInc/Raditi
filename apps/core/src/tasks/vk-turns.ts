import {
  closeVkProposal,
  failVkTurn,
  insertFeedEvent,
  pendingVkProposals,
  type PrismaClient,
} from '@repo/db'
import { isDomainError, vkCommentUrl, vkProposalPayloadSchema } from '@repo/domain'

// The proposals of a turn for the VK communities of its workspace (docs/plan/99-vk-community.md,
// §3.3): at the end of a completed pass each becomes the card «Опубликовать во ВКонтакте» in the
// chat; a failed or cancelled pass closes them unseen. Nothing here calls VK: the card's button
// does, through `vk_actions` and the queue `vk`.

export interface VkChangesDependencies {
  db: Pick<PrismaClient, '$transaction' | 'vkReservation' | 'vkCommunity' | 'taskTurn'>
  logger?: { warn(message: string): void }
}

export class VkChanges {
  readonly #deps: VkChangesDependencies

  constructor(deps: VkChangesDependencies) {
    this.#deps = deps
  }

  /**
   * Once per turn: a proposal is closed in the transaction that writes its card, so a second call
   * finds none. Never throws — the answer is already in the chat; a lost card is told in the log.
   */
  async apply(taskId: string, turn: number): Promise<void> {
    const { db, logger } = this.#deps
    try {
      const pending = await pendingVkProposals(db, taskId, turn)
      if (pending.length === 0) return
      const turnRow = await db.taskTurn.findFirst({
        where: { taskId, turnNo: turn },
        select: { id: true },
      })
      for (const proposal of pending) {
        const payload = vkProposalPayloadSchema.safeParse(proposal.payload)
        // The community may have been disconnected while the turn ran: its card would lead nowhere.
        const community = await db.vkCommunity.findFirst({
          where: { id: proposal.communityId, state: 'ok' },
          select: { name: true, groupId: true },
        })
        if (!payload.success || community === null) {
          await closeVkProposal(
            db,
            proposal.id,
            'refused',
            payload.success ? 'community' : 'invalid',
          )
          continue
        }
        const head = {
          v: 1 as const,
          reservedId: proposal.id,
          communityId: proposal.communityId,
          community: community.name,
        }
        const row =
          payload.data.kind === 'post'
            ? {
                ...head,
                kind: 'post' as const,
                text: payload.data.text,
                publishAt: payload.data.publishAt,
              }
            : {
                ...head,
                kind: 'reply' as const,
                text: payload.data.text,
                postId: payload.data.postId,
                commentId: payload.data.commentId,
                commentUrl: vkCommentUrl(
                  Number(community.groupId),
                  payload.data.postId,
                  payload.data.commentId,
                ),
              }
        await db.$transaction(async (tx) => {
          if (!(await closeVkProposal(tx, proposal.id, 'done', 'shown'))) return
          await insertFeedEvent(tx, {
            taskId,
            turnId: turnRow?.id ?? null,
            row: { type: 'feed.vk_proposal', payload: row },
          })
        })
      }
    } catch (error) {
      logger?.warn(
        `vk_proposals_failed task=${taskId} turn=${turn} reason=${isDomainError(error) ? error.code : 'unknown'}`,
      )
    }
  }

  /** The proposals of a failed or cancelled pass: closed, never shown. */
  async fail(taskId: string, turn: number): Promise<void> {
    await failVkTurn(this.#deps.db, taskId, turn).catch(() => {
      this.#deps.logger?.warn(`vk_proposals_fail_failed task=${taskId} turn=${turn}`)
    })
  }
}
