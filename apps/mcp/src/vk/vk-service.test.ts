import { vkKeyInvalid, type VkApi, type VkPost, type VkProposalPayload } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import type { McpTurnAccess } from '../access/mcp-access.ts'
import { McpVkService, type McpVkCommunity } from './vk-service.ts'

const scope: McpTurnAccess = {
  keyId: '01960000-0000-7000-8000-000000000001',
  taskId: '01960000-0000-7000-8000-000000000002',
  workspaceId: '01960000-0000-7000-8000-000000000003',
  sessionId: 'synthetic',
  turn: 4,
  firstEpoch: 1,
  epoch: 1,
  requirements: { repository: false, browser: false },
  builtinMcp: ['vk'],
}
const open: McpVkCommunity = {
  id: '01960000-0000-7000-8000-0000000000aa',
  groupId: 123,
  name: 'Кофейня',
  screenName: 'coffee',
  isClosed: false,
}
const closed: McpVkCommunity = {
  ...open,
  id: '01960000-0000-7000-8000-0000000000bb',
  isClosed: true,
}
const now = new Date('2026-11-27T12:00:00Z')
const day = 24 * 60 * 60_000

const post = (id: number, daysAgo: number, views: number, extra: Partial<VkPost> = {}): VkPost => ({
  id,
  date: new Date(now.getTime() - daysAgo * day),
  text: `Пост ${id}`,
  isPinned: false,
  attachments: 0,
  views,
  likes: 1,
  reposts: 0,
  comments: 2,
  ...extra,
})

function service(options: { key?: string | null; api?: Partial<VkApi> } = {}) {
  const reserved: { communityId: string; turnNo: number; proposal: VkProposalPayload }[] = []
  const seen: { method: string; token: string; groupId: number; args: unknown }[] = []
  const api: VkApi = {
    community: async () => {
      throw new Error('not used')
    },
    tokenPermissions: async () => [],
    posts: async (token, groupId, page) => {
      seen.push({ method: 'posts', token, groupId, args: page })
      return { total: 1, items: [post(10, 1, 100, { text: 'x'.repeat(2500) })] }
    },
    comments: async (token, groupId, postId, page) => {
      seen.push({ method: 'comments', token, groupId, args: { postId, ...page } })
      return {
        total: 2,
        items: [
          {
            id: 1,
            fromId: 77,
            date: now,
            text: 'Когда открываетесь?',
            replyToComment: null,
            threadCount: 1,
          },
          { id: 2, fromId: -123, date: now, text: 'В 9:00', replyToComment: 1, threadCount: 0 },
        ],
      }
    },
    publishPost: async () => {
      throw new Error('mcp never publishes')
    },
    replyToComment: async () => {
      throw new Error('mcp never publishes')
    },
    addCallbackServer: async () => {
      throw new Error('mcp never registers a server')
    },
    deleteCallbackServer: async () => {
      throw new Error('mcp never removes a server')
    },
    ...options.api,
  }
  const vk = new McpVkService({
    store: {
      communities: async () => [open, closed],
      community: async (workspaceId, communityId) =>
        workspaceId === scope.workspaceId
          ? ([open, closed].find((row) => row.id === communityId) ?? null)
          : null,
      reserve: async (input) => {
        reserved.push(input)
        return { reservationId: `r${reserved.length}` }
      },
    },
    api,
    serviceKey: {
      read: async () => (options.key === undefined ? 'service-key-0001' : options.key),
    },
    now: () => now,
  })
  return { vk, reserved, seen }
}

describe('McpVkService', () => {
  it('lists the communities of the workspace by their ids in Raditi', async () => {
    const { vk } = service()
    await expect(vk.communities(scope)).resolves.toEqual({
      ok: true,
      communities: [
        { communityId: open.id, name: 'Кофейня', url: 'https://vk.com/coffee', closed: false },
        { communityId: closed.id, name: 'Кофейня', url: 'https://vk.com/coffee', closed: true },
      ],
    })
  })

  it('reads posts by the service key, cuts long texts and marks them untrusted', async () => {
    const { vk, seen } = service()
    const answer = await vk.posts(scope, { communityId: open.id })
    expect(seen[0]).toEqual({
      method: 'posts',
      token: 'service-key-0001',
      groupId: 123,
      args: { count: 10, offset: 0 },
    })
    expect(answer).toMatchObject({
      ok: true,
      total: 1,
      note: expect.stringMatching(/untrusted/),
      posts: [{ postId: 10, url: 'https://vk.com/wall-123_10', cut: true, views: 100 }],
    })
    const text = (answer as unknown as { posts: { text: string }[] }).posts[0]!.text
    expect(text).toHaveLength(2001)
  })

  it('names the client’s own replies among the comments', async () => {
    const { vk } = service()
    const answer = await vk.comments(scope, { communityId: open.id, postId: 10 })
    expect(answer).toMatchObject({
      ok: true,
      comments: [
        { commentId: 1, author: 'reader 1', replies: 1, url: 'https://vk.com/wall-123_10?reply=1' },
        { commentId: 2, author: 'this community', replyTo: 1 },
      ],
    })
  })

  it('refuses another workspace’s community, a closed one and reading without the service key', async () => {
    const { vk } = service()
    await expect(
      vk.posts(
        { ...scope, workspaceId: '01960000-0000-7000-8000-0000000000ff' },
        { communityId: open.id },
      ),
    ).resolves.toMatchObject({ ok: false, code: 'VK_COMMUNITY_NOT_FOUND' })
    await expect(vk.posts(scope, { communityId: closed.id })).resolves.toMatchObject({
      ok: false,
      code: 'VK_COMMUNITY_CLOSED',
    })
    await expect(
      service({ key: null }).vk.stats(scope, { communityId: open.id }),
    ).resolves.toMatchObject({ ok: false, code: 'VK_READ_UNAVAILABLE' })
  })

  it('passes a refusal of VK to the agent as an answer', async () => {
    const { vk } = service({
      api: {
        posts: async () => {
          throw vkKeyInvalid()
        },
      },
    })
    await expect(vk.posts(scope, { communityId: open.id })).resolves.toMatchObject({
      ok: false,
      code: 'VK_KEY_INVALID',
    })
  })

  it('sums the posts of the period past a pinned old one and names the best', async () => {
    const { vk } = service({
      api: {
        posts: async () => ({
          total: 4,
          items: [
            post(1, 400, 9999, { isPinned: true }),
            post(2, 1, 100),
            post(3, 5, 300),
            post(4, 40, 50),
          ],
        }),
      },
    })
    const answer = await vk.stats(scope, { communityId: open.id, days: 30 })
    expect(answer).toMatchObject({
      ok: true,
      days: 30,
      posts: 2,
      totals: { views: 400, likes: 2, reposts: 0, comments: 4 },
      averages: { views: 200, likes: 1, comments: 2 },
      top: [{ postId: 3 }, { postId: 2 }],
    })
  })

  it('says the stats are partial only when the scan stopped at its cap with more of the period', async () => {
    const page = (offset: number, total: number, daysAgo: number) => ({
      total,
      items: Array.from({ length: 100 }, (_, index) =>
        post(offset + index + 1, daysAgo, 1, index === 0 && offset === 0 ? { isPinned: true } : {}),
      ),
    })
    // An old pinned post and 500 posts of the period: four pages read, the fifth left.
    const many = service({
      api: { posts: async (_token, _group, { offset }) => page(offset, 501, 1) },
    })
    await expect(many.vk.stats(scope, { communityId: open.id, days: 30 })).resolves.toMatchObject({
      ok: true,
      partial: true,
    })
    // Exactly 400 posts of the period and no more on the wall: complete.
    const exact = service({
      api: { posts: async (_token, _group, { offset }) => page(offset, 400, 1) },
    })
    const answer = await exact.vk.stats(scope, { communityId: open.id, days: 30 })
    expect(answer).toMatchObject({ ok: true, posts: 400 })
    expect(answer).not.toHaveProperty('partial')
  })

  it('reserves a post and a reply for the card, and publishes nothing', async () => {
    const { vk, reserved } = service()
    await expect(
      vk.proposePost(scope, {
        communityId: open.id,
        text: 'Открылись!',
        publishAt: '2026-11-28T09:00:00+03:00',
      }),
    ).resolves.toMatchObject({ ok: true, reservedId: 'r1', live: expect.stringMatching(/button/) })
    await expect(
      vk.proposeReply(scope, { communityId: open.id, postId: 10, commentId: 1, text: 'С 9:00' }),
    ).resolves.toMatchObject({ ok: true, reservedId: 'r2' })
    expect(reserved).toEqual([
      expect.objectContaining({
        communityId: open.id,
        turnNo: 4,
        proposal: { kind: 'post', text: 'Открылись!', publishAt: '2026-11-28T06:00:00.000Z' },
      }),
      expect.objectContaining({
        proposal: { kind: 'reply', postId: 10, commentId: 1, text: 'С 9:00' },
      }),
    ])
  })

  it('refuses a delayed post too soon, and a proposal for a community not connected', async () => {
    const { vk, reserved } = service()
    await expect(
      vk.proposePost(scope, { communityId: open.id, text: 'x', publishAt: '2026-11-27T12:05:00Z' }),
    ).resolves.toMatchObject({ ok: false, code: 'VK_PUBLISH_AT' })
    await expect(
      vk.proposePost(scope, { communityId: '01960000-0000-7000-8000-0000000000cc', text: 'x' }),
    ).resolves.toMatchObject({ ok: false, code: 'VK_COMMUNITY_NOT_FOUND' })
    expect(reserved).toEqual([])
  })
})
