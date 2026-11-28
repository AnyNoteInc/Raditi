import { createHash, createHmac, randomUUID } from 'node:crypto'

import {
  signVkConfirmToken,
  vkFailed,
  vkKeyInvalid,
  vkPostRefused,
  vkUnreachable,
  type VkApi,
  type VkConfirmClaims,
} from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { sweepLostVkActions, VkActions, type VkActionsDependencies } from './vk-actions.ts'

const secret = 'test-vk-confirm-secret-0123456789abcdef'
const mac = (material: string) => createHmac('sha256', secret).update(material).digest('base64url')
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex')
const now = new Date('2026-11-27T12:00:00Z')

const ids = {
  action: randomUUID(),
  workspace: randomUUID(),
  task: randomUUID(),
  community: randomUUID(),
  reservation: randomUUID(),
  user: randomUUID(),
}

interface Row {
  id: string
  workspaceId: string
  taskId: string | null
  communityId: string | null
  reservationId: string
  createdById: string
  kind: string
  args: unknown
  tokenSha256: string
  state: string
  startedAt: Date | null
  error?: string | null
  result?: unknown
}

function press(
  options: {
    text?: string
    signedText?: string
    kind?: 'post' | 'reply'
    publishAt?: string | null
    expired?: boolean
  } = {},
) {
  const text = options.text ?? 'Мы открылись!'
  const claims: VkConfirmClaims = {
    kind: options.kind ?? 'post',
    userId: ids.user,
    workspaceId: ids.workspace,
    communityId: ids.community,
    reservationId: ids.reservation,
    taskId: ids.task,
    textSha256: sha256(options.signedText ?? text),
    publishAt: options.publishAt ?? null,
    nonce: '0123456789abcdef0123456789abcdef',
    expiresAt: Math.floor(now.getTime() / 1000) + (options.expired ? -1 : 600),
  }
  const token = signVkConfirmToken(claims, mac)
  const row: Row = {
    id: ids.action,
    workspaceId: ids.workspace,
    taskId: ids.task,
    communityId: ids.community,
    reservationId: ids.reservation,
    createdById: ids.user,
    kind: claims.kind,
    args: { token, text },
    tokenSha256: sha256(token),
    state: 'queued',
    startedAt: null,
  }
  return row
}

function setup(
  row: Row,
  options: {
    api?: Partial<VkApi>
    key?: string | null
    community?: { groupId: bigint; state: string } | null
    reservation?: { kind: string; payload: unknown } | null
    mac?: VkActionsDependencies['mac']
  } = {},
) {
  const feed: { type: string; payload: Record<string, unknown> }[] = []
  const communityUpdates: unknown[] = []
  const vkAction = {
    updateMany: vi.fn(
      async ({ where, data }: { where: { id: string; state: string }; data: Partial<Row> }) => {
        if (row.id !== where.id || row.state !== where.state) return { count: 0 }
        Object.assign(row, data)
        return { count: 1 }
      },
    ),
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    findMany: vi.fn(async ({ where }: { where: { startedAt: { lt: Date } } }) =>
      row.state === 'running' && row.startedAt !== null && row.startedAt < where.startedAt.lt
        ? [{ ...row }]
        : [],
    ),
  }
  const tx = {
    vkAction,
    taskTurn: { findFirst: async () => ({ id: 'turn-1' }) },
    taskEvent: {
      create: async ({ data }: { data: { type: string; payload: Record<string, unknown> } }) => {
        feed.push({ type: data.type, payload: data.payload })
        return { id: 1n }
      },
    },
  }
  const published: unknown[] = []
  const api: VkActionsDependencies['api'] = {
    publishPost: vi.fn(async (token, groupId, post) => {
      published.push({ token, groupId, ...post })
      return { postId: 77 }
    }),
    replyToComment: vi.fn(async (token, groupId, reply) => {
      published.push({ token, groupId, ...reply })
      return { commentId: 9 }
    }),
    ...options.api,
  }
  const deps = {
    db: {
      $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
      vkAction,
      vkCommunity: {
        findFirst: async () =>
          options.community === undefined ? { groupId: 1001n, state: 'ok' } : options.community,
        updateMany: async (input: unknown) => {
          communityUpdates.push(input)
          return { count: 1 }
        },
      },
      vkReservation: {
        findUnique: async () =>
          options.reservation === undefined
            ? { kind: 'reply', payload: { kind: 'reply', postId: 10, commentId: 3, text: 'x' } }
            : options.reservation,
      },
      taskTurn: tx.taskTurn,
    } as unknown as VkActionsDependencies['db'],
    secrets: {
      kvRead: vi.fn(async () =>
        options.key === null
          ? null
          : { data: { token: options.key ?? 'vk1.a.community-key-0001' }, version: 1 },
      ),
    },
    api,
    mac: options.mac === undefined ? mac : options.mac,
    now: () => now,
  }
  return { actions: new VkActions(deps), feed, published, row, deps, communityUpdates }
}

describe('VkActions', () => {
  it('publishes the signed text from the community with its key, and tells the chat', async () => {
    const { actions, feed, published, row, deps } = setup(press())
    await actions.run(ids.action)
    expect(deps.secrets.kvRead).toHaveBeenCalledWith(
      `kv/workspaces/${ids.workspace}/vk/${ids.community}`,
    )
    expect(published).toEqual([
      { token: 'vk1.a.community-key-0001', groupId: 1001, text: 'Мы открылись!' },
    ])
    expect(row).toMatchObject({
      state: 'done',
      result: { postId: 77, url: 'https://vk.com/wall-1001_77' },
    })
    expect(feed).toEqual([
      {
        type: 'feed.vk_action',
        payload: {
          v: 1,
          actionId: ids.action,
          reservedId: ids.reservation,
          kind: 'post',
          state: 'done',
          url: 'https://vk.com/wall-1001_77',
        },
      },
    ])
  })

  it('runs a press once: a second delivery finds the row taken', async () => {
    const { actions, published } = setup(press())
    await actions.run(ids.action)
    await actions.run(ids.action)
    expect(published).toHaveLength(1)
  })

  it('sends a delayed post with its time', async () => {
    const at = '2026-11-28T06:00:00.000Z'
    const { actions, published, feed } = setup(press({ publishAt: at }))
    await actions.run(ids.action)
    expect(published).toEqual([expect.objectContaining({ publishAt: new Date(at) })])
    expect(feed[0]!.payload).toMatchObject({ state: 'done', publishAt: at })
  })

  it('replies to the comment of the proposal, never one the press names', async () => {
    const { actions, published, row } = setup(press({ kind: 'reply', text: 'С 9:00' }))
    await actions.run(ids.action)
    expect(published).toEqual([
      {
        token: 'vk1.a.community-key-0001',
        groupId: 1001,
        postId: 10,
        commentId: 3,
        text: 'С 9:00',
      },
    ])
    expect(row.result).toEqual({
      postId: 10,
      commentId: 9,
      url: 'https://vk.com/wall-1001_10?reply=9',
    })
  })

  it.each([
    [
      'a text other than the signed one',
      press({ text: 'Подменённый текст', signedText: 'Мы открылись!' }),
    ],
    ['a token of another row', { ...press(), tokenSha256: 'f'.repeat(64) }],
    ['a token of another user', { ...press(), createdById: randomUUID() }],
    ['a token of another kind', { ...press(), kind: 'reply' }],
  ])('refuses %s and never calls VK', async (_name, row) => {
    const { actions, published, feed } = setup(row)
    await actions.run(ids.action)
    expect(published).toEqual([])
    expect(row).toMatchObject({ state: 'failed', error: 'VK_CONFIRM_INVALID' })
    expect(feed[0]!.payload).toMatchObject({ state: 'failed', error: 'VK_CONFIRM_INVALID' })
  })

  it('refuses an expired press, a forged signature and a process without the secret', async () => {
    const expired = setup(press({ expired: true }))
    await expired.actions.run(ids.action)
    expect(expired.row).toMatchObject({ state: 'failed', error: 'VK_CONFIRM_EXPIRED' })
    const forged = setup(press(), { mac: (material) => mac(`${material}x`) })
    await forged.actions.run(ids.action)
    expect(forged.row).toMatchObject({ state: 'failed', error: 'VK_CONFIRM_INVALID' })
    const none = setup(press(), { mac: null })
    await none.actions.run(ids.action)
    expect(none.row).toMatchObject({ state: 'failed', error: 'VK_CONFIRM_INVALID' })
    expect([...expired.published, ...forged.published, ...none.published]).toEqual([])
  })

  it('refuses without a key or a working community', async () => {
    const noKey = setup(press(), { key: null })
    await noKey.actions.run(ids.action)
    expect(noKey.row).toMatchObject({ state: 'failed', error: 'VK_KEY_INVALID' })
    const gone = setup(press(), { community: null })
    await gone.actions.run(ids.action)
    expect(gone.row).toMatchObject({ state: 'failed', error: 'VK_COMMUNITY_NOT_FOUND' })
  })

  it('tells a refusal of VK, and marks the community whose key VK refused', async () => {
    const refused = setup(press(), {
      api: {
        publishPost: async () => {
          throw vkPostRefused()
        },
      },
    })
    await refused.actions.run(ids.action)
    expect(refused.row).toMatchObject({ state: 'failed', error: 'VK_POST_REFUSED' })
    const key = setup(press(), {
      api: {
        publishPost: async () => {
          throw vkKeyInvalid()
        },
      },
    })
    await key.actions.run(ids.action)
    expect(key.row).toMatchObject({ state: 'failed', error: 'VK_KEY_INVALID' })
    expect(key.communityUpdates).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ state: 'refused' }) }),
    ])
  })

  it('takes an unanswered call as lost, never sent again (ВК9)', async () => {
    const { actions, row, feed } = setup(press(), {
      api: {
        publishPost: async () => {
          throw vkUnreachable()
        },
      },
    })
    await actions.run(ids.action)
    expect(row.state).toBe('lost')
    expect(feed[0]!.payload).toMatchObject({ state: 'lost' })
  })

  it('fails, never loses, a press whose key cannot be read: nothing went to VK', async () => {
    const { actions, row, published, deps } = setup(press())
    deps.secrets.kvRead.mockRejectedValueOnce(new Error('Vault is down'))
    await actions.run(ids.action)
    expect(published).toEqual([])
    expect(row).toMatchObject({ state: 'failed', error: 'VK_UNREACHABLE' })
  })

  it('takes a success of an unexpected shape as lost: the post may be out', async () => {
    const { actions, row } = setup(press(), {
      api: {
        publishPost: async () => {
          throw vkFailed()
        },
      },
    })
    await actions.run(ids.action)
    expect(row.state).toBe('lost')
  })

  it('publishes nothing for a press whose community was disconnected', async () => {
    const { actions, row, published } = setup({ ...press(), communityId: null })
    await actions.run(ids.action)
    expect(published).toEqual([])
    expect(row).toMatchObject({ state: 'failed', error: 'VK_COMMUNITY_NOT_FOUND' })
  })

  it('sweeps a press whose process died in the call, without a key or VK', async () => {
    const row = { ...press(), state: 'running', startedAt: new Date(now.getTime() - 10 * 60_000) }
    const { deps, feed } = setup(row)
    await expect(sweepLostVkActions(deps.db, { now: () => now })).resolves.toBe(1)
    expect(row.state).toBe('lost')
    expect(feed[0]!.payload).toMatchObject({ state: 'lost' })
    expect(deps.secrets.kvRead).not.toHaveBeenCalled()
  })
})
