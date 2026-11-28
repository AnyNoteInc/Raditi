import { createHmac } from 'node:crypto'

import { enqueueVkCommentNotices, prisma, vkCallbackCommunity } from '@repo/db'
import { vkCallbackSecret } from '@repo/domain'

import { env } from '@/env'
import { handleVkCallback } from '@/server/vk-callback'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * The Callback API of a connected VK community (docs/plan/99-vk-community.md, slice 99.6): the
 * confirmation of the server and the events of new comments.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ communityId: string }> },
): Promise<Response> {
  const { communityId } = await params
  return handleVkCallback(request, communityId, {
    community: (id) => vkCallbackCommunity(prisma, id),
    secretOf: (id) => {
      const secret = env.vk().confirmSecret
      return secret
        ? vkCallbackSecret(id, (material) =>
            createHmac('sha256', secret).update(material).digest('base64url'),
          )
        : null
    },
    notify: (community, now) => enqueueVkCommentNotices(prisma, community, now),
  })
}
