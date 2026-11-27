import { z } from 'zod'

import { vkLimits } from './limits.ts'

// The jobs of the queue `vk` (docs/plan/99-vk-community.md, §3.3): a publication the client pressed,
// run by core.

export const vkJobNames = Object.freeze({
  /** One row of `vk_actions`: check its token, read the key, call VK, write the feed. */
  action: 'vk.action',
})

export const vkActionPayloadSchema = z.strictObject({ actionId: z.uuid() })
export type VkActionPayload = z.infer<typeof vkActionPayloadSchema>

/** `vk_actions.args`: the token of the press and the text it names by its hash. */
export const vkActionArgsSchema = z.strictObject({
  token: z.string().min(1).max(2048),
  text: z.string().min(1).max(vkLimits.postChars),
})
export type VkActionArgs = z.infer<typeof vkActionArgsSchema>

/** A row taken longer ago than this and not finished is `lost` (ВК9): its call may have gone out. */
export const VK_ACTION_LOST_AFTER_MS = 5 * 60_000
