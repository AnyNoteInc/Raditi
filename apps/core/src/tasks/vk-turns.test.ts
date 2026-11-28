import { randomUUID } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { VkChanges, type VkChangesDependencies } from './vk-turns.ts'

const taskId = randomUUID()
const communityId = randomUUID()

interface Reservation {
  id: string
  communityId: string
  payload: unknown
  outcome: string | null
  reason?: string
}

function setup(reservations: Reservation[], community: { name: string; groupId: bigint } | null) {
  const feed: { type: string; payload: unknown }[] = []
  const vkReservation = {
    findMany: async () => reservations.filter((row) => row.outcome === null),
    updateMany: async ({
      where,
      data,
    }: {
      where: { id?: string; taskId?: string; outcome: null }
      data: { outcome: string; reason: string }
    }) => {
      const rows = reservations.filter(
        (row) => row.outcome === null && (where.id === undefined || row.id === where.id),
      )
      for (const row of rows) Object.assign(row, data)
      return { count: rows.length }
    },
  }
  const tx = {
    vkReservation,
    taskEvent: {
      create: async ({ data }: { data: { type: string; payload: unknown } }) => {
        feed.push({ type: data.type, payload: data.payload })
        return { id: 1n }
      },
    },
  }
  const db = {
    $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
    vkReservation,
    vkCommunity: { findFirst: async () => community },
    taskTurn: { findFirst: async () => ({ id: 'turn-1' }) },
  } as unknown as VkChangesDependencies['db']
  return { changes: new VkChanges({ db }), feed }
}

describe('VkChanges', () => {
  it('shows each proposal of a completed turn as a card, once', async () => {
    const post: Reservation = {
      id: randomUUID(),
      communityId,
      payload: { kind: 'post', text: 'Мы открылись!', publishAt: null },
      outcome: null,
    }
    const reply: Reservation = {
      id: randomUUID(),
      communityId,
      payload: { kind: 'reply', postId: 10, commentId: 3, text: 'С 9:00' },
      outcome: null,
    }
    const { changes, feed } = setup([post, reply], { name: 'Кофейня у дома', groupId: 1001n })
    await changes.apply(taskId, 2)
    await changes.apply(taskId, 2)
    expect(feed).toEqual([
      {
        type: 'feed.vk_proposal',
        payload: {
          v: 1,
          kind: 'post',
          reservedId: post.id,
          communityId,
          community: 'Кофейня у дома',
          text: 'Мы открылись!',
          publishAt: null,
        },
      },
      {
        type: 'feed.vk_proposal',
        payload: {
          v: 1,
          kind: 'reply',
          reservedId: reply.id,
          communityId,
          community: 'Кофейня у дома',
          text: 'С 9:00',
          postId: 10,
          commentId: 3,
          commentUrl: 'https://vk.com/wall-1001_10?reply=3',
        },
      },
    ])
    expect([post.outcome, reply.outcome]).toEqual(['done', 'done'])
  })

  it('shows no card for a community disconnected while the turn ran', async () => {
    const post: Reservation = {
      id: randomUUID(),
      communityId,
      payload: { kind: 'post', text: 'x', publishAt: null },
      outcome: null,
    }
    const { changes, feed } = setup([post], null)
    await changes.apply(taskId, 1)
    expect(feed).toEqual([])
    expect(post).toMatchObject({ outcome: 'refused', reason: 'community' })
  })

  it('closes the proposals of a failed pass unseen', async () => {
    const post: Reservation = {
      id: randomUUID(),
      communityId,
      payload: { kind: 'post', text: 'x', publishAt: null },
      outcome: null,
    }
    const { changes, feed } = setup([post], { name: 'Кофейня', groupId: 1n })
    await changes.fail(taskId, 1)
    await changes.apply(taskId, 1)
    expect(feed).toEqual([])
    expect(post).toMatchObject({ outcome: 'failed' })
  })
})
