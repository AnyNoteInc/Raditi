import { z } from 'zod'

import { vkLimits } from './limits.ts'

// The feed rows of a VK community (docs/plan/99-vk-community.md, §3.3): the card of a post or a
// reply the agent proposed, and what the client's button did. No key, no answer of VK.

const vkId = z.number().int().positive()
const httpsUrl = z.url({ protocol: /^https$/ }).max(500)

/** `feed.vk_proposal` v1 — the card «Опубликовать во ВКонтакте». */
export const feedVkProposalPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('post'),
    reservedId: z.uuid(),
    communityId: z.uuid(),
    community: z.string().min(1).max(200),
    text: z.string().min(1).max(vkLimits.postChars),
    publishAt: z.iso.datetime({ offset: true }).nullable(),
  }),
  z.strictObject({
    v: z.literal(1),
    kind: z.literal('reply'),
    reservedId: z.uuid(),
    communityId: z.uuid(),
    community: z.string().min(1).max(200),
    text: z.string().min(1).max(vkLimits.replyChars),
    postId: vkId,
    commentId: vkId,
    /** The comment it answers, as the card shows it. */
    commentUrl: httpsUrl,
  }),
])
export type FeedVkProposalPayload = z.infer<typeof feedVkProposalPayloadSchema>

export const vkActionKinds = ['post', 'reply'] as const
export type VkActionKind = (typeof vkActionKinds)[number]

/** `lost` — the call went to VK and its answer did not come back (ВК9): nobody knows if it is out. */
export const vkActionStates = ['queued', 'running', 'done', 'failed', 'lost'] as const
export type VkActionState = (typeof vkActionStates)[number]

/** `feed.vk_action` v1. */
export const feedVkActionPayloadSchema = z.strictObject({
  v: z.literal(1),
  actionId: z.uuid(),
  reservedId: z.uuid(),
  kind: z.enum(vkActionKinds),
  state: z.enum(vkActionStates),
  url: httpsUrl.optional(),
  /** A delayed post: when VK publishes it. */
  publishAt: z.iso.datetime({ offset: true }).optional(),
  /** The code of a refusal (`VK_POST_REFUSED`…): the card says it in the client's words. */
  error: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,39}$/)
    .optional(),
})
export type FeedVkActionPayload = z.infer<typeof feedVkActionPayloadSchema>
