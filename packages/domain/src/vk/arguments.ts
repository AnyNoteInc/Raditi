import { z } from 'zod'

import { vkLimits } from './limits.ts'

// The arguments of the VK tools of the agent (docs/plan/99-vk-community.md, §3.2). The request
// policy of mcp checks the same schemas before mcp-nest sees a call, so a refused call never
// reaches a tool. The community is the id of its row in Raditi (`vk_communities.id`), never the id
// of VK: the agent cannot name a community the workspace has not connected.

const communityId = z.uuid()
const vkId = z
  .number()
  .int()
  .positive()
  .max(2 ** 53 - 1)

/** A text the agent proposes: no control characters but line breaks and tabs. */
const proposedText = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine(
      // eslint-disable-next-line no-control-regex -- line breaks and tabs only
      (text) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text),
      'no control characters',
    )

export const vkCommunitiesArgumentsSchema = z.strictObject({})
export type VkCommunitiesArguments = z.infer<typeof vkCommunitiesArgumentsSchema>

export const vkPostsArgumentsSchema = z.strictObject({
  communityId,
  count: z.number().int().min(1).max(vkLimits.postsPerPage).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
})
export type VkPostsArguments = z.infer<typeof vkPostsArgumentsSchema>

export const vkCommentsArgumentsSchema = z.strictObject({
  communityId,
  postId: vkId,
  /** The thread of this comment instead of the comments of the post. */
  commentId: vkId.optional(),
  count: z.number().int().min(1).max(vkLimits.commentsPerPage).optional(),
  offset: z.number().int().min(0).max(10_000).optional(),
})
export type VkCommentsArguments = z.infer<typeof vkCommentsArgumentsSchema>

export const vkStatsArgumentsSchema = z.strictObject({
  communityId,
  days: z.number().int().min(1).max(vkLimits.statsDays).optional(),
})
export type VkStatsArguments = z.infer<typeof vkStatsArgumentsSchema>

export const vkPostProposeArgumentsSchema = z.strictObject({
  communityId,
  text: proposedText(vkLimits.postChars),
  /** A delayed post: an ISO instant with its offset, 10 minutes to a year ahead (checked by the tool). */
  publishAt: z.iso.datetime({ offset: true }).optional(),
})
export type VkPostProposeArguments = z.infer<typeof vkPostProposeArgumentsSchema>

export const vkReplyProposeArgumentsSchema = z.strictObject({
  communityId,
  postId: vkId,
  commentId: vkId,
  text: proposedText(vkLimits.replyChars),
})
export type VkReplyProposeArguments = z.infer<typeof vkReplyProposeArgumentsSchema>

/** What a proposal keeps (`vk_reservations.payload`) and the card shows. */
export const vkProposalPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('post'),
    text: proposedText(vkLimits.postChars),
    publishAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  z.strictObject({
    kind: z.literal('reply'),
    postId: vkId,
    commentId: vkId,
    text: proposedText(vkLimits.replyChars),
  }),
])
export type VkProposalPayload = z.infer<typeof vkProposalPayloadSchema>

/**
 * Whether a delayed post's instant is within its bounds at `now`: null — fine, otherwise the English
 * words the agent reads.
 */
export function vkPublishAtProblem(publishAt: Date, now: Date): string | null {
  const ahead = publishAt.getTime() - now.getTime()
  if (!Number.isFinite(ahead)) return 'publishAt is not an instant'
  if (ahead < vkLimits.publishAtMinAheadMs)
    return 'publishAt must be at least 10 minutes ahead; omit it to publish when the client presses'
  if (ahead > vkLimits.publishAtMaxAheadMs) return 'publishAt must be within a year'
  return null
}
