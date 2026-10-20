import { Logger } from '@nestjs/common'
import { Prisma, type PrismaClient } from '@repo/db'
import type { JobQueue } from '@repo/domain'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  OUTBOX_ENQUEUE_TIMEOUT_MS,
  OUTBOX_LEASE_MARGIN_MS,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_BACKOFF_MS,
  OUTBOX_RETENTION_MS,
  OutboxRelayService,
  outboxBackoffMs,
} from './outbox-relay.service.ts'

interface Row {
  id: string
  topic: string
  type: string
  payload: unknown
  dedupe_key: string | null
  attempts: number
  created_at: Date
}

const rowId = (n: number) => `0199a1b2-0000-7000-8000-${String(n).padStart(12, '0')}`

const row = (overrides: Partial<Row> = {}): Row => ({
  id: rowId(1),
  topic: 'notifications',
  type: 'auth.welcome',
  payload: { to: 'owner@example.ru', name: 'Ольга', appUrl: 'https://raditi.ru' },
  dedupe_key: null,
  attempts: 0,
  created_at: new Date('2026-09-26T11:00:00Z'),
  ...overrides,
})

/** `count` rows created one second apart, in that order. */
const rows = (count: number): Row[] =>
  Array.from({ length: count }, (_, i) =>
    row({ id: rowId(i + 1), created_at: new Date(Date.UTC(2026, 8, 26, 11, 0, i)) }),
  )

function setup(
  claimed: Row[],
  enqueue: JobQueue['enqueue'] = vi.fn().mockResolvedValue(undefined),
) {
  const queryRaw = vi.fn().mockResolvedValue(claimed)
  const updateMany = vi.fn().mockResolvedValue({ count: 1 })
  const deleteMany = vi.fn().mockResolvedValue({ count: 3 })
  const prisma = { $queryRaw: queryRaw, outboxEvent: { updateMany, deleteMany } }
  const queue = { enqueue: vi.fn(enqueue) }
  const relay = new OutboxRelayService(
    prisma as unknown as PrismaClient,
    queue as unknown as JobQueue,
    false,
  )
  const published = (id: string) => ({
    where: { id, lockedBy: relay.relayId },
    data: {
      status: 'published',
      publishedAt: expect.any(Date),
      payload: Prisma.DbNull,
      lockedAt: null,
      lockedBy: null,
    },
  })
  const released = (ids: string[]) => ({
    where: { id: { in: ids }, lockedBy: relay.relayId },
    data: { lockedAt: null, lockedBy: null },
  })
  return { relay, queue, queryRaw, updateMany, deleteMany, published, released }
}

beforeAll(() => {
  Logger.overrideLogger(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('OutboxRelayService.tick', () => {
  it('claims due rows in one statement: pending, unlocked or with a lapsed lease, skipping locked ones', async () => {
    const { relay, queryRaw } = setup([])

    await expect(relay.tick()).resolves.toBe(0)

    expect(queryRaw).toHaveBeenCalledOnce()
    const sql = (queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join('?')
    expect(sql).toMatch(/FROM outbox_events/)
    expect(sql).toMatch(/status = 'pending' AND available_at <= now\(\)/)
    expect(sql).toMatch(
      /locked_at IS NULL\s+OR locked_at < now\(\) - \?::int \* interval '1 millisecond'/,
    )
    expect(sql).toMatch(/ORDER BY created_at/)
    expect(sql).toMatch(/FOR UPDATE SKIP LOCKED/)
    expect(sql).toMatch(/SET locked_at = now\(\), locked_by = \?/)
    expect(sql).toMatch(/RETURNING/)
    expect(queryRaw.mock.calls[0]?.slice(1)).toEqual([OUTBOX_LEASE_MS, 50, relay.relayId])
    expect(relay.relayId.length).toBeLessThanOrEqual(64)
  })

  it('publishes claimed rows oldest first, then marks each one published and unclaimed, without its payload', async () => {
    const first = row()
    const second = row({
      id: rowId(2),
      type: 'auth.verify_email',
      payload: { to: 'owner@example.ru', url: 'https://raditi.ru/verify?token=t1' },
      dedupe_key: 'auth.verify_email:abc',
      created_at: new Date('2026-09-26T11:00:01Z'),
    })
    // UPDATE … RETURNING gives no order.
    const { relay, queue, updateMany, published } = setup([second, first])

    await expect(relay.tick()).resolves.toBe(2)

    expect(queue.enqueue.mock.calls).toEqual([
      ['notifications', 'auth.welcome', first.payload, { jobId: first.id }],
      ['notifications', 'auth.verify_email', second.payload, { jobId: 'auth.verify_email:abc' }],
    ])
    expect(updateMany.mock.calls).toEqual([[published(first.id)], [published(second.id)]])
  })

  it('marks every row right after its enqueue, never after the whole batch', async () => {
    const { relay, queue, updateMany } = setup(rows(3))
    const order: string[] = []
    queue.enqueue.mockImplementation(async (_queue, _name, _payload, opts) => {
      order.push(`enqueue ${opts?.jobId}`)
    })
    updateMany.mockImplementation(async ({ where }: { where: { id: string } }) => {
      order.push(`mark ${where.id}`)
      return { count: 1 }
    })

    await relay.tick()

    expect(order).toEqual([1, 2, 3].flatMap((n) => [`enqueue ${rowId(n)}`, `mark ${rowId(n)}`]))
  })

  it('marks a row with an unknown topic failed and goes on with the batch', async () => {
    const unknown = row({ topic: 'emails' })
    const next = row({ id: rowId(2), created_at: new Date('2026-09-26T11:00:01Z') })
    const { relay, queue, updateMany, published } = setup([unknown, next])

    await relay.tick()

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: unknown.id, lockedBy: relay.relayId },
      data: {
        status: 'failed',
        lastError: 'Unknown topic "emails"',
        lockedAt: null,
        lockedBy: null,
      },
    })
    expect(queue.enqueue).toHaveBeenCalledOnce()
    expect(queue.enqueue.mock.calls[0]?.[0]).toBe('notifications')
    expect(updateMany).toHaveBeenNthCalledWith(2, published(next.id))
  })

  it('marks a pending row without a payload failed, never enqueues it and goes on', async () => {
    const empty = row({ payload: null })
    const next = row({ id: rowId(2), created_at: new Date('2026-09-26T11:00:01Z') })
    const { relay, queue, updateMany, published } = setup([empty, next])

    await expect(relay.tick()).resolves.toBe(2)

    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: empty.id, lockedBy: relay.relayId },
      data: { status: 'failed', lastError: 'Payload is missing', lockedAt: null, lockedBy: null },
    })
    expect(queue.enqueue).toHaveBeenCalledOnce()
    expect(queue.enqueue.mock.calls[0]?.[3]).toEqual({ jobId: next.id })
    expect(updateMany).toHaveBeenNthCalledWith(2, published(next.id))
  })

  it('backs off exponentially after a failed enqueue and releases the rest for the next pass', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
    const [failing, ...rest] = rows(3).map((r, i) => (i === 0 ? { ...r, attempts: 2 } : r))
    const { relay, queue, updateMany, released } = setup(
      [failing!, ...rest],
      vi.fn().mockRejectedValue(new Error('Connection is closed.')),
    )

    await relay.tick()

    expect(queue.enqueue).toHaveBeenCalledOnce()
    expect(updateMany.mock.calls).toEqual([
      [
        {
          where: { id: failing!.id, lockedBy: relay.relayId },
          data: {
            attempts: 3,
            lastError: 'Connection is closed.',
            availableAt: new Date('2026-09-26T12:00:08Z'),
            lockedAt: null,
            lockedBy: null,
          },
        },
      ],
      [released([rowId(2), rowId(3)])],
    ])
  })

  it('caps the backoff at 10 minutes', () => {
    expect(outboxBackoffMs(1)).toBe(2_000)
    expect(outboxBackoffMs(2)).toBe(4_000)
    expect(outboxBackoffMs(9)).toBe(512_000)
    expect(outboxBackoffMs(10)).toBe(OUTBOX_MAX_BACKOFF_MS)
    expect(outboxBackoffMs(30)).toBe(OUTBOX_MAX_BACKOFF_MS)
  })

  it('marks the row failed after the 10th failed attempt', async () => {
    const { relay, updateMany } = setup(
      [row({ attempts: 9 })],
      vi.fn().mockRejectedValue(new Error('boom')),
    )

    await relay.tick()

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: row().id, lockedBy: relay.relayId },
      data: { attempts: 10, lastError: 'boom', status: 'failed', lockedAt: null, lockedBy: null },
    })
  })

  it('truncates long errors', async () => {
    const { relay, updateMany } = setup(
      [row()],
      vi.fn().mockRejectedValue(new Error('x'.repeat(5_000))),
    )

    await relay.tick()

    const data = updateMany.mock.calls[0]?.[0].data as { lastError: string }
    expect(data.lastError).toHaveLength(1_000)
    expect(data.lastError.endsWith('…')).toBe(true)
  })

  it('treats an enqueue that hangs as a failure after the timeout', async () => {
    vi.useFakeTimers()
    const { relay, updateMany } = setup([row()], () => new Promise<never>(() => {}))

    const pass = relay.tick()
    await vi.advanceTimersByTimeAsync(OUTBOX_ENQUEUE_TIMEOUT_MS)
    await pass

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: row().id, lockedBy: relay.relayId },
      data: expect.objectContaining({ attempts: 1, lastError: expect.stringMatching(/timed out/) }),
    })
  })

  it('stops publishing before the lease runs out when Redis is slow, and releases the rest', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
    const slowEnqueueMs = 4_000
    const batch = rows(20)
    // Every enqueue succeeds, just slowly: all 20 would take 80 s, longer than the lease.
    const { relay, queue, updateMany, released } = setup(batch, async () => {
      vi.setSystemTime(Date.now() + slowEnqueueMs)
    })

    await expect(relay.tick()).resolves.toBe(20)

    // The last enqueue starts while enqueue timeout + margin still fit into the lease.
    const fit =
      Math.floor(
        (OUTBOX_LEASE_MS - OUTBOX_ENQUEUE_TIMEOUT_MS - OUTBOX_LEASE_MARGIN_MS) / slowEnqueueMs,
      ) + 1
    expect(queue.enqueue).toHaveBeenCalledTimes(fit)
    expect(Date.now() - new Date('2026-09-26T12:00:00Z').getTime()).toBeLessThan(
      OUTBOX_LEASE_MS - OUTBOX_LEASE_MARGIN_MS + slowEnqueueMs,
    )
    expect(updateMany).toHaveBeenCalledTimes(fit + 1)
    expect(updateMany).toHaveBeenLastCalledWith(released(batch.slice(fit).map((r) => r.id)))
  })

  it('warns and goes on when the lease ran out and another relay took the row', async () => {
    const { relay, updateMany, queue } = setup(rows(2))
    updateMany.mockResolvedValueOnce({ count: 0 })

    await expect(relay.tick()).resolves.toBe(2)

    expect(queue.enqueue).toHaveBeenCalledTimes(2)
    expect(updateMany).toHaveBeenCalledTimes(2)
  })

  it('fails the pass when marking a row fails, and releases it with the rest', async () => {
    const { relay, updateMany, released } = setup(rows(3))
    updateMany.mockRejectedValueOnce(new Error('database is down'))

    await expect(relay.tick()).resolves.toBe(0)

    expect(updateMany).toHaveBeenCalledTimes(2)
    expect(updateMany).toHaveBeenLastCalledWith(released([rowId(1), rowId(2), rowId(3)]))
  })

  it('never runs two passes at once', async () => {
    let release: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const { relay, queryRaw, queue } = setup([row()], () => blocked)

    const first = relay.tick()
    await vi.waitFor(() => expect(queue.enqueue).toHaveBeenCalledOnce())
    await expect(relay.tick()).resolves.toBe(0)
    expect(queryRaw).toHaveBeenCalledOnce()

    release()
    await expect(first).resolves.toBe(1)
    await relay.tick()
    expect(queryRaw).toHaveBeenCalledTimes(2)
  })

  it('resolves after a failed pass and slows down polling until the database is back', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-26T12:00:00Z'))
    const { relay, queryRaw } = setup([row()])
    queryRaw.mockRejectedValueOnce(new Error('database is down'))

    await expect(relay.tick()).resolves.toBe(0)
    await expect(relay.tick()).resolves.toBe(0)
    expect(queryRaw).toHaveBeenCalledOnce()

    vi.setSystemTime(new Date('2026-09-26T12:00:02Z'))
    await expect(relay.tick()).resolves.toBe(1)
    expect(queryRaw).toHaveBeenCalledTimes(2)
  })
})

describe('OutboxRelayService.onModuleDestroy', () => {
  it('lets the running pass finish its row, releases the rest and starts no new pass', async () => {
    let finish: () => void = () => {}
    const { relay, queue, queryRaw, updateMany, published, released } = setup(rows(3), () => {
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    })

    const pass = relay.tick()
    await vi.waitFor(() => expect(queue.enqueue).toHaveBeenCalledOnce())
    const destroyed = relay.onModuleDestroy()
    finish()
    await destroyed
    await pass

    expect(queue.enqueue).toHaveBeenCalledOnce()
    expect(updateMany.mock.calls).toEqual([[published(rowId(1))], [released([rowId(2), rowId(3)])]])
    await expect(relay.tick()).resolves.toBe(0)
    expect(queryRaw).toHaveBeenCalledOnce()
  })

  it('waits for a running purge before the database pool closes', async () => {
    let finish: (value: { count: number }) => void = () => {}
    const { relay, deleteMany } = setup([])
    deleteMany.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      }),
    )

    const purge = relay.purge()
    let destroyed = false
    const destroy = relay.onModuleDestroy().then(() => {
      destroyed = true
    })
    await new Promise((resolve) => setImmediate(resolve))
    expect(destroyed).toBe(false)

    finish({ count: 0 })
    await destroy
    await expect(purge).resolves.toBe(0)
  })
})

describe('OutboxRelayService.purge', () => {
  it('deletes published and failed rows older than seven days', async () => {
    const { relay, deleteMany } = setup([])
    const now = new Date('2026-09-26T12:00:00Z')
    const before = new Date(now.getTime() - OUTBOX_RETENTION_MS)

    await expect(relay.purge(now)).resolves.toBe(3)

    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: 'published', publishedAt: { lt: before } },
          { status: 'failed', createdAt: { lt: before } },
        ],
      },
    })
  })

  it('joins a purge that is already running', async () => {
    const { relay, deleteMany } = setup([])

    const [first, second] = await Promise.all([relay.purge(), relay.purge()])

    expect(first).toBe(3)
    expect(second).toBe(3)
    expect(deleteMany).toHaveBeenCalledOnce()
  })
})
