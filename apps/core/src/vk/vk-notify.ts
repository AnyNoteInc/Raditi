import { Logger } from '@nestjs/common'
import type { PrismaClient } from '@repo/db'
import { VK_COMMENT_NOTICE, VK_COMMENT_NOTICE_PAUSE_MS, type VkNotifyPayload } from '@repo/domain'

import type { NotificationDelivery } from '../tasks/notification-delivery.ts'

// A notice of a new comment in a VK community (docs/plan/99-vk-community.md, slice 99.6): to one
// owner or admin of its workspace, while they still are one and the community is still connected.
// At most one in VK_COMMENT_NOTICE_PAUSE_MS per community and person — a burst of comments is one
// notice. By push and the bot, never a letter; no word and no author of the comment (spec §11).

export class VkNotify {
  readonly #logger = new Logger('VkNotify')

  constructor(
    private readonly deps: {
      db: Pick<PrismaClient, 'vkCommunity' | 'member' | 'chatNotification'>
      delivery: Pick<NotificationDelivery, 'deliver'>
      now?: () => Date
    },
  ) {}

  async run(job: VkNotifyPayload): Promise<void> {
    const { db, delivery } = this.deps
    const now = this.deps.now?.() ?? new Date()
    const community = await db.vkCommunity.findFirst({
      where: { id: job.communityId, state: 'ok' },
      select: { name: true, workspaceId: true },
    })
    if (community === null) return
    const member = await db.member.findUnique({
      where: { workspaceId_userId: { workspaceId: community.workspaceId, userId: job.userId } },
      select: { role: true },
    })
    if (member === null || (member.role !== 'owner' && member.role !== 'admin')) return
    const recent = await db.chatNotification.count({
      where: {
        userId: job.userId,
        vkCommunityId: job.communityId,
        createdAt: { gt: new Date(now.getTime() - VK_COMMENT_NOTICE_PAUSE_MS) },
      },
    })
    if (recent > 0) return
    const answer = await delivery.deliver({
      userId: job.userId,
      kind: VK_COMMENT_NOTICE,
      chat: null,
      schedule: null,
      vk: { communityId: job.communityId },
      path: '/settings/builtin-mcp',
      letter: false,
      telegram: {
        text: `Новый комментарий в группе «${community.name}» во ВКонтакте.`,
        button: 'Открыть Радити',
      },
    })
    this.#logger.log(`vk_notify answer=${answer}`)
  }
}
