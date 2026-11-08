import { randomUUID } from 'node:crypto'

import { Logger } from '@nestjs/common'
import { Prisma, type PrismaClient } from '@repo/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { CONTENT_SNAPSHOT_TTL_MS } from '../privacy/content-expiry.ts'
import { WebMaskSweep } from './web-mask-sweep.ts'

const HOUR = 60 * 60_000

/** A database with `tasks` due: each page of the listing gives the next list. */
function fakeDb(pages: Array<Array<{ id: string; siteId: string | null }>>) {
  const queries: Prisma.Sql[] = []
  const listed = [...pages]
  const due = new Map(pages.flat().map((task) => [task.id, task]))
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = Prisma.sql(strings, ...values)
      queries.push(query)
      if (query.text.includes('llm_keys')) return []
      if (query.text.includes('FOR UPDATE')) {
        const task = due.get(values[0] as string)
        return task ? [task] : []
      }
      return listed.shift() ?? []
    }),
    $executeRaw: vi.fn(async () => 1),
    turnAssignment: { count: vi.fn(async () => 0) },
  }
  const db = { $transaction: vi.fn((work: (client: typeof tx) => unknown) => work(tx)) }
  return { db: db as unknown as Pick<PrismaClient, '$transaction'>, tx, spy: db, queries }
}

const site = randomUUID()
const task = () => ({ id: randomUUID(), siteId: site })

describe('the sweep of contact maps', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('removes the map of a task under the site, of a chat under its own id', async () => {
    const chat = { id: randomUUID(), siteId: null }
    const onSite = task()
    const { db, tx } = fakeDb([[onSite, chat]])
    const secrets = { kvDestroyAll: vi.fn(async () => undefined) }
    expect(await new WebMaskSweep(db, secrets).sweep()).toEqual({
      visited: 2,
      purged: 2,
      failed: 0,
    })
    expect(secrets.kvDestroyAll.mock.calls).toEqual([
      [`kv/content-masks/${site}/${onSite.id}`],
      [`kv/content-masks/${chat.id}/${chat.id}`],
    ])
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2)
  })

  it('asks the one predicate of the window, with no window or status list of its own', async () => {
    const { db, queries } = fakeDb([[task()]])
    await new WebMaskSweep(db, { kvDestroyAll: vi.fn() }).sweep()
    const dated = queries.filter((query) => query.text.includes('finished_at'))
    // The listing and the claim.
    expect(dated).toHaveLength(2)
    for (const query of dated) {
      expect(query.text).toContain('web_masks_purged_at IS NULL')
      expect(query.text).toContain('content_masks_purged_at IS NULL')
      expect(query.values).toContain(CONTENT_SNAPSHOT_TTL_MS / 1000)
    }
  })

  it('goes through every page', async () => {
    const full = Array.from({ length: 100 }, task)
    const last = task()
    const { db, queries } = fakeDb([full, [last]])
    expect(await new WebMaskSweep(db, { kvDestroyAll: vi.fn() }).sweep()).toMatchObject({
      visited: 101,
      purged: 101,
    })
    const listings = queries.filter((query) => query.text.includes('ORDER BY id'))
    expect(listings).toHaveLength(2)
    expect(listings[1]!.values).toContain(full.at(-1)!.id)
  })

  it('leaves a task whose map it could not remove for the next hour', async () => {
    const { db, tx } = fakeDb([[task()]])
    const secrets = { kvDestroyAll: vi.fn().mockRejectedValue(new Error('vault.internal')) }
    expect(await new WebMaskSweep(db, secrets).sweep()).toMatchObject({ purged: 0, failed: 1 })
    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })

  it('runs once an hour from the start of the app and stops with it', async () => {
    const { db, spy } = fakeDb([])
    const sweep = new WebMaskSweep(db, { kvDestroyAll: vi.fn() })
    await vi.advanceTimersByTimeAsync(2 * HOUR)
    expect(spy.$transaction).not.toHaveBeenCalled()
    sweep.onApplicationBootstrap()
    await vi.advanceTimersByTimeAsync(HOUR - 1)
    expect(spy.$transaction).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(spy.$transaction).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(spy.$transaction).toHaveBeenCalledTimes(2)
    await sweep.beforeApplicationShutdown()
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(spy.$transaction).toHaveBeenCalledTimes(2)
  })

  it('never starts a second run beside the first, and stopping waits for it at its next task', async () => {
    const tasks = [task(), task()]
    const { db } = fakeDb([tasks])
    let unblock = () => {}
    const secrets = {
      kvDestroyAll: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            unblock = resolve
          }),
      ),
    }
    const sweep = new WebMaskSweep(db, secrets)
    sweep.onApplicationBootstrap()
    await vi.advanceTimersByTimeAsync(3 * HOUR)
    expect(secrets.kvDestroyAll).toHaveBeenCalledTimes(1)
    let stopped = false
    const stopping = sweep.beforeApplicationShutdown().then(() => {
      stopped = true
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(stopped).toBe(false)
    unblock()
    await stopping
    // The second task of the page was not begun: the database closes after this.
    expect(secrets.kvDestroyAll).toHaveBeenCalledTimes(1)
  })

  it('logs counts and the name of an error, and survives an outage of the database', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {})
    const { db, spy } = fakeDb([[task()]])
    const secrets = { kvDestroyAll: vi.fn().mockRejectedValue(new Error('kv/content-masks/x/y')) }
    const sweep = new WebMaskSweep(db, secrets)
    sweep.onApplicationBootstrap()
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(warn).toHaveBeenLastCalledWith('web_mask_sweep purged=0 failed=1')

    spy.$transaction.mockImplementationOnce(() => {
      throw new TypeError('postgresql://raditi:secret@db.internal')
    })
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(warn).toHaveBeenLastCalledWith('web_mask_sweep stopped: TypeError')

    // The third hour runs: listing and claim, the refused listing, then this listing.
    await vi.advanceTimersByTimeAsync(HOUR)
    expect(spy.$transaction).toHaveBeenCalledTimes(4)
    await sweep.beforeApplicationShutdown()
  })
})
