import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { handleVkCallback, type VkCallbackCommunityRow } from './vk-callback'

const ID = '0199a000-0000-7000-8000-0000000000a1'
const community: VkCallbackCommunityRow = {
  id: ID,
  workspaceId: '0199a000-0000-7000-8000-0000000000b1',
  groupId: 1001,
  callbackCode: 'c0nf1rm',
}

function setup(row: VkCallbackCommunityRow | null = community) {
  const notify = vi.fn(async () => 1)
  const call = (body: unknown, id = ID) =>
    handleVkCallback(
      new Request('https://raditi.test/api/webhooks/vk/x', {
        method: 'POST',
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
      id,
      {
        community: async (asked) => (asked === ID ? row : null),
        secretOf: () => 'Secret123',
        notify,
        now: () => new Date('2026-11-27T12:00:00Z'),
      },
    )
  return { call, notify }
}

const comment = (fromId: number, secret = 'Secret123') => ({
  type: 'wall_reply_new',
  group_id: 1001,
  event_id: 'e1',
  secret,
  object: { id: 5, from_id: fromId, post_id: 10, text: 'Когда открываетесь?' },
})

describe('the Callback API of VK', () => {
  it('answers the confirmation with the code of the community', async () => {
    const { call } = setup()
    const answer = await call({ type: 'confirmation', group_id: 1001 })
    expect(answer.status).toBe(200)
    expect(await answer.text()).toBe('c0nf1rm')
  })

  it('tells of a new comment of a reader, and of none of the community itself', async () => {
    const { call, notify } = setup()
    const answer = await call(comment(77))
    expect(await answer.text()).toBe('ok')
    expect(notify).toHaveBeenCalledWith(community, new Date('2026-11-27T12:00:00Z'))
    await call(comment(-1001))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('refuses an event without the secret, and takes other events silently', async () => {
    const { call, notify } = setup()
    expect((await call(comment(77, 'wrong'))).status).toBe(403)
    expect((await call({ ...comment(77), secret: undefined })).status).toBe(403)
    const other = await call({ type: 'group_join', group_id: 1001, secret: 'Secret123' })
    expect(await other.text()).toBe('ok')
    expect(notify).not.toHaveBeenCalled()
  })

  it('knows no other community, group or body', async () => {
    const { call, notify } = setup()
    expect((await call(comment(77), '0199a000-0000-7000-8000-0000000000ff')).status).toBe(404)
    expect((await call({ ...comment(77), group_id: 2002 })).status).toBe(404)
    expect((await call(comment(77), 'not-a-uuid')).status).toBe(404)
    expect((await call('not json')).status).toBe(400)
    expect((await call({ group_id: 1001 })).status).toBe(400)
    expect(notify).not.toHaveBeenCalled()
  })

  it('tells nothing for a community without the server of Raditi', async () => {
    const { call, notify } = setup({ ...community, callbackCode: null })
    expect((await call({ type: 'confirmation', group_id: 1001 })).status).toBe(404)
    expect(await (await call(comment(77))).text()).toBe('ok')
    expect(notify).not.toHaveBeenCalled()
  })
})

describe('the body of an event of VK', () => {
  it('is not read beyond 64 KiB', async () => {
    const { call, notify } = setup()
    const answer = await call({ ...comment(77), padding: 'x'.repeat(70 * 1024) })
    expect(answer.status).toBe(413)
    expect(notify).not.toHaveBeenCalled()
  })
})
