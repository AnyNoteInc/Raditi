import 'server-only'

import { timingSafeEqual } from 'node:crypto'

import { vkCallbackEventSchema, vkWallReplySchema } from '@repo/domain'

import { readBodyWithin } from './body-limit'

// The Callback API of a connected VK community (docs/plan/99-vk-community.md, §3.4, slice 99.6):
// `POST /api/webhooks/vk/<communityId>`. VK first asks for the confirmation code of the server, then
// posts its events with the secret of the server; a new comment of anyone but the community itself
// becomes the notices of its owners and admins. VK wants «ok» for every event it should not send
// again; nothing of the event is kept or logged.

/** A body of VK is a small JSON object; a larger one is not read. */
export const VK_CALLBACK_BODY_MAX = 64 * 1024

export interface VkCallbackCommunityRow {
  id: string
  workspaceId: string
  groupId: number
  callbackCode: string | null
}

export interface VkCallbackDeps {
  community(communityId: string): Promise<VkCallbackCommunityRow | null>
  /** The secret of the server of this community; null — no secret: no event is taken. */
  secretOf(communityId: string): string | null
  /** A new comment came: the notices of the owners and admins. */
  notify(community: VkCallbackCommunityRow, now: Date): Promise<unknown>
  now?: () => Date
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const text = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } })

function sameSecret(given: string | undefined, expected: string): boolean {
  if (given === undefined) return false
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function handleVkCallback(
  request: Request,
  communityId: string,
  deps: VkCallbackDeps,
): Promise<Response> {
  if (!UUID.test(communityId)) return text('not found', 404)
  // Read within the limit, as it streams: a body without its length is cut off at the limit too.
  const body = await readBodyWithin(request, VK_CALLBACK_BODY_MAX).catch(() => null)
  if (body === null) return text('too large', 413)
  const raw = body.toString('utf8')
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return text('bad request', 400)
  }
  const event = vkCallbackEventSchema.safeParse(json)
  if (!event.success) return text('bad request', 400)
  const community = await deps.community(communityId)
  if (community === null || community.groupId !== event.data.group_id) return text('not found', 404)
  if (event.data.type === 'confirmation')
    return community.callbackCode === null ? text('not found', 404) : text(community.callbackCode)
  // A community without the server of Raditi (a key without «Управление» replaced it): no notices.
  if (community.callbackCode === null) return text('ok')
  const secret = deps.secretOf(community.id)
  if (secret === null || !sameSecret(event.data.secret, secret)) return text('forbidden', 403)
  if (event.data.type === 'wall_reply_new') {
    const reply = vkWallReplySchema.safeParse(event.data.object)
    // The community's own replies are told to nobody.
    if (reply.success && reply.data.from_id !== -community.groupId)
      await deps.notify(community, (deps.now ?? (() => new Date()))())
  }
  return text('ok')
}
