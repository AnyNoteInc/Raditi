import { z } from 'zod'

// The Callback API of a connected VK community (docs/plan/99-vk-community.md, §3.4, slice 99.6):
// VK posts each new comment to `POST /api/webhooks/vk/<communityId>` of web. The secret of the
// server is derived — HMAC by VK_CONFIRM_SECRET of the community's id — so it is kept nowhere and
// web never reads it back from Vault; the confirmation code of VK is not a secret and stays in the
// row of the community. Nothing of the comment but its existence goes further: the notice says
// only that a comment came, never its words or its author (spec §11).

/** The route of the webhook of a community, under the address of the cabinet. */
export const vkCallbackPath = (communityId: string): string => `/api/webhooks/vk/${communityId}`

/** The title of Raditi's server in «Управление → Работа с API → Callback API» of the community. */
export const VK_CALLBACK_TITLE = 'Raditi'

/** At most one notice of new comments per community in this time. */
export const VK_COMMENT_NOTICE_PAUSE_MS = 10 * 60_000

/** The secret of the server of a community: letters and digits, as VK takes it (at most 50). */
export function vkCallbackSecret(communityId: string, mac: (material: string) => string): string {
  return mac(`raditi-vk-callback:v1:${communityId}`)
    .replace(/[^A-Za-z0-9]/g, '')
    .slice(0, 32)
}

/** What every event of VK carries; the rest is read by its type. */
export const vkCallbackEventSchema = z.object({
  type: z.string().min(1).max(64),
  group_id: z.number().int().positive(),
  event_id: z.string().min(1).max(128).optional(),
  secret: z.string().max(64).optional(),
  object: z.unknown().optional(),
})
export type VkCallbackEvent = z.infer<typeof vkCallbackEventSchema>

/** What `wall_reply_new` tells of a comment: only who wrote it — the community itself or not. */
export const vkWallReplySchema = z.object({
  id: z.number().int().positive(),
  from_id: z.number().int(),
  post_id: z.number().int().positive(),
})
