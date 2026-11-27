import { randomUUID } from 'node:crypto'

import { describe, expect, it, vi } from 'vitest'

import { VkNotify } from './vk-notify.ts'

const communityId = randomUUID()
const userId = randomUUID()
const now = new Date('2026-11-27T12:00:00Z')

function setup(options: { community?: boolean; role?: string | null; recent?: number } = {}) {
  const deliver = vi.fn(async () => 'sent' as const)
  const counted: unknown[] = []
  const notify = new VkNotify({
    db: {
      vkCommunity: {
        findFirst: async () =>
          options.community === false ? null : { name: 'Кофейня у дома', workspaceId: 'ws' },
      },
      member: {
        findUnique: async () => (options.role === null ? null : { role: options.role ?? 'owner' }),
      },
      chatNotification: {
        count: async (input: unknown) => {
          counted.push(input)
          return options.recent ?? 0
        },
      },
    } as never,
    delivery: { deliver },
    now: () => now,
  })
  return { notify, deliver, counted }
}

describe('VkNotify', () => {
  it('tells an owner by push and the bot, never by a letter, with nothing of the comment', async () => {
    const { notify, deliver, counted } = setup()
    await notify.run({ communityId, userId })
    expect(deliver).toHaveBeenCalledWith({
      userId,
      kind: 'vk_comment',
      chat: null,
      schedule: null,
      vk: { communityId },
      path: '/settings/builtin-mcp',
      letter: false,
      telegram: {
        text: 'Новый комментарий в группе «Кофейня у дома» во ВКонтакте.',
        button: 'Открыть Радити',
      },
    })
    expect(counted).toEqual([
      {
        where: {
          userId,
          vkCommunityId: communityId,
          createdAt: { gt: new Date(now.getTime() - 10 * 60_000) },
        },
      },
    ])
  })

  it('tells nobody of a community gone, a member who manages nothing, or within ten minutes', async () => {
    for (const options of [
      { community: false },
      { role: 'member' },
      { role: null },
      { recent: 1 },
    ]) {
      const { notify, deliver } = setup(options)
      await notify.run({ communityId, userId })
      expect(deliver, JSON.stringify(options)).not.toHaveBeenCalled()
    }
  })
})
