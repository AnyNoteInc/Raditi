import { createHash } from 'node:crypto'

import { insertFeedEvent, type Prisma, type PrismaClient } from '@repo/db'
import {
  isDomainError,
  readVkConfirmToken,
  VK_ACTION_LOST_AFTER_MS,
  VK_TOKEN_FIELD,
  vkActionArgsSchema,
  vkCommentUrl,
  vkCommunitySecretPath,
  vkKeyInvalid,
  vkPostUrl,
  vkProposalPayloadSchema,
  vkSecretSchema,
  type FeedVkActionPayload,
  type SecretStore,
  type VkApi,
  type VkConfirmMac,
} from '@repo/domain'

// The presses of «Опубликовать» on the cards of VK (docs/plan/99-vk-community.md, §3.3, rule 4,
// ВК9): one row of `vk_actions`, taken once; its token checked again by VK_CONFIRM_SECRET and
// matched with the row, the text with the hash the press signed; the key of the community read
// from Vault (`core-vk`) for this call alone; then VK, and the feed of the chat. A call that went to
// VK and did not come back is never repeated: the row becomes `lost`.

type Tx = Prisma.TransactionClient

export interface VkActionsDependencies {
  db: Pick<PrismaClient, '$transaction' | 'vkAction' | 'vkCommunity' | 'vkReservation' | 'taskTurn'>
  secrets: Pick<SecretStore, 'kvRead'>
  api: Pick<VkApi, 'publishPost' | 'replyToComment'>
  /** HMAC by VK_CONFIRM_SECRET; null — no secret: no press runs. */
  mac: VkConfirmMac | null
  now?: () => Date
  logger?: { log(message: string): void; warn(message: string): void }
}

type Outcome =
  | {
      state: 'done'
      result: { postId: number; commentId?: number; url: string }
      publishAt?: string
    }
  | { state: 'failed'; error: string }
  | { state: 'lost' }

/** The call went to VK and its answer is unknown: the press is `lost`, never sent again (ВК9). */
class CallUnanswered extends Error {
  constructor(readonly reason: string) {
    super('The call to VK was not answered')
  }
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')

/** Refusals of the check: the press itself is wrong, nothing went to VK. */
const refused = (error: string): Outcome => ({ state: 'failed', error })

export class VkActions {
  readonly #deps: VkActionsDependencies
  readonly #now: () => Date

  constructor(deps: VkActionsDependencies) {
    this.#deps = deps
    this.#now = deps.now ?? (() => new Date())
  }

  /** Runs one press; a second delivery of its job finds the row taken and does nothing. */
  async run(actionId: string): Promise<void> {
    const { db, logger } = this.#deps
    const now = this.#now()
    const taken = await db.vkAction.updateMany({
      where: { id: actionId, state: 'queued' },
      data: { state: 'running', startedAt: now },
    })
    if (taken.count === 0) return
    const row = await db.vkAction.findUniqueOrThrow({
      where: { id: actionId },
      select: {
        id: true,
        workspaceId: true,
        taskId: true,
        communityId: true,
        reservationId: true,
        createdById: true,
        kind: true,
        args: true,
        tokenSha256: true,
      },
    })
    let outcome: Outcome
    try {
      outcome = await this.#publish(row, now)
    } catch (error) {
      if (error instanceof CallUnanswered) {
        // Thrown after the call went out — the answer is unknown (ВК9).
        logger?.warn(`vk_action_lost action=${actionId} reason=${error.reason}`)
        outcome = { state: 'lost' }
      } else {
        // Before the call — Vault, the database: nothing went to VK.
        logger?.warn(
          `vk_action_failed action=${actionId} reason=${isDomainError(error) ? error.code : 'unknown'}`,
        )
        outcome = { state: 'failed', error: 'VK_UNREACHABLE' }
      }
    }
    await this.#finish(row, outcome)
    logger?.log(`vk_action action=${actionId} kind=${row.kind} state=${outcome.state}`)
  }

  /**
   * Rows taken longer ago than VK_ACTION_LOST_AFTER_MS and not finished — their process died in the
   * call — become `lost`, told in the chat. The count.
   */
  async sweep(): Promise<number> {
    const { db } = this.#deps
    const before = new Date(this.#now().getTime() - VK_ACTION_LOST_AFTER_MS)
    const stale = await db.vkAction.findMany({
      where: { state: 'running', startedAt: { lt: before } },
      select: {
        id: true,
        workspaceId: true,
        taskId: true,
        communityId: true,
        reservationId: true,
        createdById: true,
        kind: true,
        args: true,
        tokenSha256: true,
      },
      take: 100,
    })
    for (const row of stale) await this.#finish(row, { state: 'lost' })
    return stale.length
  }

  async #publish(row: ActionRow, now: Date): Promise<Outcome> {
    const { db, secrets, api, mac } = this.#deps
    if (mac === null) return refused('VK_CONFIRM_INVALID')
    const args = vkActionArgsSchema.safeParse(row.args)
    if (!args.success) return refused('VK_CONFIRM_INVALID')
    let claims
    try {
      claims = readVkConfirmToken(args.data.token, mac, now)
    } catch (error) {
      return refused(isDomainError(error) ? error.code : 'VK_CONFIRM_INVALID')
    }
    // The token names exactly this row: its press, its user, its proposal and its text.
    // A community disconnected after the press: its key is gone, nothing goes to VK.
    if (row.communityId === null) return refused('VK_COMMUNITY_NOT_FOUND')
    if (
      sha256(args.data.token) !== row.tokenSha256 ||
      claims.userId !== row.createdById ||
      claims.workspaceId !== row.workspaceId ||
      claims.communityId !== row.communityId ||
      claims.reservationId !== row.reservationId ||
      claims.taskId !== row.taskId ||
      claims.kind !== row.kind ||
      claims.textSha256 !== sha256(args.data.text)
    )
      return refused('VK_CONFIRM_INVALID')
    const community = await db.vkCommunity.findFirst({
      where: { id: row.communityId, workspaceId: row.workspaceId },
      select: { groupId: true, state: true },
    })
    if (community === null) return refused('VK_COMMUNITY_NOT_FOUND')
    if (community.state !== 'ok') return refused('VK_KEY_INVALID')
    const stored = await secrets.kvRead(vkCommunitySecretPath(row.workspaceId, row.communityId))
    const key = stored === null ? null : vkSecretSchema.safeParse(stored.data)
    if (key === null || !key.success) return refused('VK_KEY_INVALID')
    const token = key.data[VK_TOKEN_FIELD]
    const groupId = Number(community.groupId)
    // From here the call may go out: a refusal of VK is an answer, anything else is `lost`.
    try {
      if (claims.kind === 'post') {
        const publishAt = claims.publishAt === null ? undefined : new Date(claims.publishAt)
        const { postId } = await api.publishPost(token, groupId, {
          text: args.data.text,
          ...(publishAt ? { publishAt } : {}),
        })
        return {
          state: 'done',
          result: { postId, url: vkPostUrl(groupId, postId) },
          ...(claims.publishAt ? { publishAt: claims.publishAt } : {}),
        }
      }
      const reply = await this.#replyTarget(row)
      if (reply === null) return refused('VK_CONFIRM_INVALID')
      const { commentId } = await api.replyToComment(token, groupId, {
        ...reply,
        text: args.data.text,
      })
      return {
        state: 'done',
        result: {
          postId: reply.postId,
          commentId,
          url: vkCommentUrl(groupId, reply.postId, commentId),
        },
      }
    } catch (error) {
      // No answer, or an answer that is not VK's refusal (VK_FAILED: an error code the table does
      // not know, or a success of an unexpected shape — the post may be out): unknown, never failed.
      if (!isDomainError(error) || error.code === 'VK_UNREACHABLE' || error.code === 'VK_FAILED')
        throw new CallUnanswered(isDomainError(error) ? error.code : 'unknown')
      // A refused key is told on the community: the cabinet asks for a new one.
      if (error.code === vkKeyInvalid().code)
        await db.vkCommunity.updateMany({
          where: { id: row.communityId },
          data: { state: 'refused', stateReason: error.code, checkedAt: now },
        })
      return { state: 'failed', error: error.code }
    }
  }

  /** The post and the comment a reply answers: from the card of its proposal, never the press. */
  async #replyTarget(row: ActionRow): Promise<{ postId: number; commentId: number } | null> {
    const reservation = await this.#deps.db.vkReservation.findUnique({
      where: { id: row.reservationId },
      select: { payload: true, kind: true },
    })
    const payload = vkProposalPayloadSchema.safeParse(reservation?.payload)
    if (!payload.success || payload.data.kind !== 'reply') return null
    return { postId: payload.data.postId, commentId: payload.data.commentId }
  }

  async #finish(row: ActionRow, outcome: Outcome): Promise<void> {
    const { db, logger } = this.#deps
    const finishedAt = this.#now()
    const feed: FeedVkActionPayload = {
      v: 1,
      actionId: row.id,
      reservedId: row.reservationId,
      kind: row.kind as FeedVkActionPayload['kind'],
      state: outcome.state,
      ...(outcome.state === 'done' ? { url: outcome.result.url } : {}),
      ...(outcome.state === 'done' && outcome.publishAt ? { publishAt: outcome.publishAt } : {}),
      ...(outcome.state === 'failed' ? { error: outcome.error.slice(0, 40) } : {}),
    }
    try {
      await db.$transaction(async (tx: Tx) => {
        const closed = await tx.vkAction.updateMany({
          where: { id: row.id, state: 'running' },
          data: {
            state: outcome.state,
            finishedAt,
            error: outcome.state === 'failed' ? outcome.error.slice(0, 40) : null,
            ...(outcome.state === 'done' ? { result: outcome.result } : {}),
          },
        })
        if (closed.count === 0 || row.taskId === null) return
        const turn = await tx.taskTurn.findFirst({
          where: { taskId: row.taskId },
          orderBy: { turnNo: 'desc' },
          select: { id: true },
        })
        await insertFeedEvent(tx, {
          taskId: row.taskId,
          turnId: turn?.id ?? null,
          row: { type: 'feed.vk_action', payload: feed },
        })
      })
    } catch (error) {
      logger?.warn(
        `vk_action_finish_failed action=${row.id} reason=${isDomainError(error) ? error.code : 'unknown'}`,
      )
    }
  }
}

interface ActionRow {
  id: string
  workspaceId: string
  taskId: string | null
  /** null — the community was disconnected after the press. */
  communityId: string | null
  reservationId: string
  createdById: string
  kind: string
  args: Prisma.JsonValue
  tokenSha256: string
}

/**
 * The sweep of the presses whose process died in the call (`VkActions.sweep`), from the sweep of
 * tasks: it needs the database alone — no key is read and VK is never called. The count.
 */
export function sweepLostVkActions(
  db: VkActionsDependencies['db'],
  options: { now?: () => Date; logger?: VkActionsDependencies['logger'] } = {},
): Promise<number> {
  const never = async (): Promise<never> => {
    throw new Error('The sweep of VK presses never calls VK')
  }
  return new VkActions({
    db,
    secrets: { kvRead: async () => null },
    api: { publishPost: never, replyToComment: never },
    mac: null,
    ...options,
  }).sweep()
}
