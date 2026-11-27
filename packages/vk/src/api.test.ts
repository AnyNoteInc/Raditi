import { isDomainError } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import { VkHttpApi, type VkFetch } from './api.ts'

interface Seen {
  url: string
  body: URLSearchParams
  init: RequestInit
}

function fake(answer: unknown | ((seen: Seen) => Response), status = 200) {
  const seen: Seen[] = []
  const fetch: VkFetch = async (url, init) => {
    const call = { url, body: new URLSearchParams(String(init.body)), init }
    seen.push(call)
    if (typeof answer === 'function') return (answer as (seen: Seen) => Response)(call)
    return new Response(JSON.stringify(answer), { status })
  }
  const api = new VkHttpApi({ fetch, minIntervalMs: 0, baseUrl: 'https://vk.test/method/' })
  return { api, seen }
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (isDomainError(error)) return error.code
    throw error
  }
  throw new Error('expected a refusal')
}

describe('VkHttpApi', () => {
  it('posts the key in the body, never in the address, with the version of the API', async () => {
    const { api, seen } = fake({ response: { post_id: 77 } })
    await expect(api.publishPost('vk1.a.secret', 123, { text: 'Новость' })).resolves.toEqual({
      postId: 77,
    })
    expect(seen[0]!.url).toBe('https://vk.test/method/wall.post')
    expect(seen[0]!.url).not.toContain('secret')
    expect(seen[0]!.init.method).toBe('POST')
    expect(seen[0]!.init.redirect).toBe('error')
    expect(Object.fromEntries(seen[0]!.body)).toEqual({
      owner_id: '-123',
      from_group: '1',
      message: 'Новость',
      access_token: 'vk1.a.secret',
      v: '5.199',
    })
  })

  it('sends a delayed post with its instant in seconds', async () => {
    const { api, seen } = fake({ response: { post_id: 1 } })
    await api.publishPost('k'.repeat(20), 5, {
      text: 'x',
      publishAt: new Date('2026-12-01T09:00:00Z'),
    })
    expect(seen[0]!.body.get('publish_date')).toBe(String(Date.UTC(2026, 11, 1, 9) / 1000))
  })

  it('replies to a comment from the community', async () => {
    const { api, seen } = fake({ response: { comment_id: 9, parents_stack: [] } })
    await expect(
      api.replyToComment('k'.repeat(20), 5, { postId: 3, commentId: 4, text: 'Спасибо' }),
    ).resolves.toEqual({ commentId: 9 })
    expect(seen[0]!.url).toMatch(/wall\.createComment$/)
    expect(seen[0]!.body.get('reply_to_comment')).toBe('4')
    expect(seen[0]!.body.get('from_group')).toBe('5')
  })

  it('reads a community in both shapes of groups.getById', async () => {
    const group = { id: 5, name: 'Кофейня', screen_name: 'coffee', is_closed: 0 }
    const expected = { groupId: 5, name: 'Кофейня', screenName: 'coffee', isClosed: false }
    await expect(
      fake({ response: { groups: [group], profiles: [] } }).api.community('k'),
    ).resolves.toEqual(expected)
    await expect(
      fake({ response: [{ ...group, is_closed: 1 }] }).api.community('k'),
    ).resolves.toEqual({
      ...expected,
      isClosed: true,
    })
  })

  it('reads the rights of a key', async () => {
    const { api } = fake({
      response: {
        mask: 0,
        permissions: [
          { setting: 8192, name: 'wall' },
          { setting: 262144, name: 'manage' },
        ],
      },
    })
    await expect(api.tokenPermissions('k')).resolves.toEqual(['wall', 'manage'])
  })

  it('reads posts with their counters and fills what VK leaves out', async () => {
    const { api, seen } = fake({
      response: {
        count: 42,
        items: [
          {
            id: 10,
            date: 1_700_000_000,
            text: 'Пост',
            is_pinned: 1,
            attachments: [{ type: 'photo' }],
            views: { count: 100 },
            likes: { count: 5 },
            reposts: { count: 1 },
            comments: { count: 2 },
          },
          { id: 11, date: 1_700_000_100 },
        ],
      },
    })
    const page = await api.posts('k', 5, { count: 2, offset: 0 })
    expect(seen[0]!.body.get('owner_id')).toBe('-5')
    expect(page.total).toBe(42)
    expect(page.items[0]).toEqual({
      id: 10,
      date: new Date(1_700_000_000_000),
      text: 'Пост',
      isPinned: true,
      attachments: 1,
      views: 100,
      likes: 5,
      reposts: 1,
      comments: 2,
    })
    expect(page.items[1]).toMatchObject({ text: '', views: 0, isPinned: false, attachments: 0 })
  })

  it('reads the comments of a post or of a thread', async () => {
    const { api, seen } = fake({
      response: {
        count: 1,
        items: [{ id: 3, from_id: 77, date: 1_700_000_000, text: 'Вопрос', thread: { count: 2 } }],
      },
    })
    const page = await api.comments('k', 5, 10, { count: 50, offset: 0, commentId: 3 })
    expect(seen[0]!.body.get('comment_id')).toBe('3')
    expect(page.items[0]).toEqual({
      id: 3,
      fromId: 77,
      date: new Date(1_700_000_000_000),
      text: 'Вопрос',
      replyToComment: null,
      threadCount: 2,
    })
  })

  it('turns an error of VK into a refusal without its words', async () => {
    const { api } = fake({
      error: { error_code: 5, error_msg: 'User authorization failed: secret' },
    })
    const error = await api.community('k').catch((caught: unknown) => caught)
    expect(isDomainError(error) && error.code).toBe('VK_KEY_INVALID')
    expect(String((error as Error).message)).not.toContain('secret')
    expect(
      await refusal(fake({ error: { error_code: 214 } }).api.publishPost('k', 1, { text: 'x' })),
    ).toBe('VK_POST_REFUSED')
  })

  it('takes a network failure, a bad status, a strange answer and a huge body as unreachable', async () => {
    const failing: VkFetch = async () => {
      throw new Error('connect ECONNREFUSED with the key in it')
    }
    const api = new VkHttpApi({ fetch: failing, minIntervalMs: 0 })
    expect(await refusal(api.community('k'))).toBe('VK_UNREACHABLE')
    expect(await refusal(fake({}, 502).api.community('k'))).toBe('VK_UNREACHABLE')
    expect(await refusal(fake({}, 429).api.community('k'))).toBe('VK_RATE_LIMITED')
    expect(await refusal(fake(() => new Response('<html>')).api.community('k'))).toBe(
      'VK_UNREACHABLE',
    )
    expect(await refusal(fake({ ok: true }).api.community('k'))).toBe('VK_UNREACHABLE')
    const huge = new VkHttpApi({
      fetch: async () => new Response('x'.repeat(100)),
      maxBodyBytes: 10,
      minIntervalMs: 0,
    })
    expect(await refusal(huge.community('k'))).toBe('VK_UNREACHABLE')
  })

  it('takes an answer of a wrong shape as a failure of VK', async () => {
    expect(
      await refusal(fake({ response: { nope: 1 } }).api.publishPost('k', 1, { text: 'x' })),
    ).toBe('VK_FAILED')
  })

  it('spaces its calls', async () => {
    let clock = 0
    const slept: number[] = []
    const api = new VkHttpApi({
      fetch: async () => new Response(JSON.stringify({ response: { post_id: 1 } })),
      minIntervalMs: 350,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms)
        clock += ms
      },
    })
    await api.publishPost('k', 1, { text: 'a' })
    await api.publishPost('k', 1, { text: 'b' })
    expect(slept).toEqual([350])
  })
})
