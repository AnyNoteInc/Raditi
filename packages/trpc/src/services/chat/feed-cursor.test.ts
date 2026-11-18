import { randomUUID } from 'node:crypto'

import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { createPrismaClient, insertFeedEvent, type PrismaClient } from '@repo/db'
import { feedLimits, feedReadCursorSchema, legalDocuments } from '@repo/domain'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { readDialogExport, readDialogFeed } from './feed.ts'

// The cursor of the feed on PostgreSQL (feedReadCursorSchema): a row with a smaller id that
// commits after a larger one is read by the next read, never skipped; a row is given again only
// as the same row. Every test works in a chat of its own.

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: the cursor of the feed', () => {
  let db: PrismaClient
  let userId: string
  let workspaceId: string

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    const user = await db.user.create({
      data: { name: 'Feed cursor', email: `${randomUUID()}@feed-cursor.example.ru` },
    })
    userId = user.id
    await db.userConsent.createMany({
      data: legalDocuments.flatMap((document) =>
        document.required && document.consentType
          ? [
              {
                userId,
                documentType: document.consentType,
                documentVersion: document.version,
                granted: true,
                source: 'sign_up' as const,
              },
            ]
          : [],
      ),
    })
    workspaceId = (
      await db.$transaction((tx) => ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }))
    ).id
  })
  afterAll(async () => {
    await db.task.deleteMany({ where: { workspaceId } })
    await db.creditLedger.deleteMany({ where: { account: { workspaceId } } })
    await db.billingAccount.deleteMany({ where: { workspaceId } })
    await db.member.deleteMany({ where: { workspaceId } })
    await db.workspace.deleteMany({ where: { id: workspaceId } })
    await db.user.deleteMany({ where: { id: userId } })
    await db.$disconnect()
  })

  /** A chat without a project, waiting for the client. */
  async function chat(): Promise<string> {
    const task = await db.task.create({
      data: {
        workspaceId,
        createdById: userId,
        status: 'awaiting_user',
        title: 'Курсор',
        needsBrowser: true,
      },
      select: { id: true },
    })
    return task.id
  }

  const words = (text: string) =>
    ({
      type: 'feed.request',
      payload: { v: 1, kind: 'first', authorId: userId, requestId: randomUUID(), text },
    }) as const

  const read = (taskId: string, after: string) => readDialogFeed(db, { userId, taskId, after })

  /** Every row a reader keeps, reading from `after` until the feed has no more. */
  async function readAll(taskId: string, after: string, kept = new Map<string, string>()) {
    let cursor = after
    for (let reads = 0; ; reads += 1) {
      expect(reads).toBeLessThan(50)
      const answer = await read(taskId, cursor)
      expect(feedReadCursorSchema.safeParse(answer.cursor).success).toBe(true)
      for (const event of answer.events)
        if (event.type === 'feed.request')
          kept.set(event.id, 'text' in event ? (event.text ?? '') : '')
      cursor = answer.cursor
      if (!answer.more) return { kept, cursor }
    }
  }

  /** A transaction that wrote rows of the feed and stays open until `commit` is called. */
  async function openWriter(taskId: string, texts: readonly string[]) {
    const written = Promise.withResolvers<bigint[]>()
    const release = Promise.withResolvers<void>()
    const done = db.$transaction(
      async (tx) => {
        const ids: bigint[] = []
        for (const text of texts) ids.push(await insertFeedEvent(tx, { taskId, row: words(text) }))
        written.resolve(ids)
        await release.promise
      },
      { timeout: 60_000 },
    )
    done.catch((error: unknown) => written.reject(error))
    const ids = await written.promise
    return {
      ids,
      commit: async () => {
        release.resolve()
        await done
      },
    }
  }

  it('reads a row that committed after a row with a larger id, at the next read', async () => {
    const taskId = await chat()
    const { kept, cursor } = await readAll(taskId, '0')
    expect(kept.size).toBe(0)

    // The first writer takes the smaller id and is slow to commit; the second commits at once.
    const slow = await openWriter(taskId, ['раньше по номеру, позже по времени'])
    const fast = await insertFeedEvent(db, { taskId, row: words('позже по номеру') })
    expect(fast > slow.ids[0]!).toBe(true)

    const seen = await readAll(taskId, cursor, kept)
    expect([...seen.kept.values()]).toEqual(['позже по номеру'])
    // The cursor moved past the larger id: by id alone the slow row would be skipped for good.
    expect(BigInt(seen.cursor.split('.')[0]!)).toBe(fast)

    await slow.commit()
    const after = await readAll(taskId, seen.cursor, seen.kept)
    expect([...after.kept.entries()].sort(([a], [b]) => (BigInt(a) < BigInt(b) ? -1 : 1))).toEqual([
      [String(slow.ids[0]), 'раньше по номеру, позже по времени'],
      [String(fast), 'позже по номеру'],
    ])
    // Once read, the rows of transactions long committed are not given again.
    const quiet = await read(taskId, after.cursor)
    expect(quiet.events).toEqual([])
  })

  it('reads a cursor of an id alone as it read before the horizon', async () => {
    const taskId = await chat()
    const first = await insertFeedEvent(db, { taskId, row: words('один') })
    const second = await insertFeedEvent(db, { taskId, row: words('два') })
    const answer = await read(taskId, String(first))
    expect(answer.events.map((event) => event.id)).toEqual([String(second)])
    expect(answer.cursor.startsWith(`${second}.`)).toBe(true)
  })

  it('reads every row of a long feed page by page, and the late ones of a page too', async () => {
    const taskId = await chat()
    const slow = await openWriter(taskId, ['медленная'])
    for (let index = 0; index < feedLimits.page + 20; index += 1)
      await insertFeedEvent(db, { taskId, row: words(`строка ${index}`) })
    const first = await readAll(taskId, '0')
    expect(first.kept.size).toBe(feedLimits.page + 20)
    await slow.commit()
    const all = await readAll(taskId, first.cursor, first.kept)
    expect(all.kept.size).toBe(feedLimits.page + 21)
    expect(all.kept.get(String(slow.ids[0]))).toBe('медленная')
  })

  it('neither loops nor gives a row again while a transaction elsewhere stays open', async () => {
    // A writing transaction of another chat, open the whole time: the oldest open one.
    const elsewhere = await chat()
    const held = await openWriter(elsewhere, ['держит транзакцию'])
    const taskId = await chat()
    for (let index = 0; index < 2 * feedLimits.page + 10; index += 1)
      await insertFeedEvent(db, { taskId, row: words(`строка ${index}`) })
    let reads = 0
    let cursor = '0'
    const seen = new Map<string, number>()
    for (;;) {
      reads += 1
      expect(reads).toBeLessThan(10)
      const answer = await read(taskId, cursor)
      expect(answer.cursor).not.toBe('0')
      for (const event of answer.events) seen.set(event.id, (seen.get(event.id) ?? 0) + 1)
      cursor = answer.cursor
      if (!answer.more) break
    }
    expect(seen.size).toBe(2 * feedLimits.page + 10)
    expect([...seen.values()].every((times) => times === 1)).toBe(true)
    // A poll after the end gives nothing it gave.
    expect((await read(taskId, cursor)).events).toEqual([])
    await held.commit()
    expect((await read(taskId, cursor)).events).toEqual([])
  })

  it('exports every row of a long chat once, whatever transaction is open meanwhile', async () => {
    const elsewhere = await chat()
    const held = await openWriter(elsewhere, ['держит транзакцию'])
    const taskId = await chat()
    for (let index = 0; index < feedLimits.page + 30; index += 1)
      await insertFeedEvent(db, { taskId, row: words(`строка ${index}`) })
    const { markdown } = await readDialogExport(db, { userId, taskId })
    for (const index of [0, feedLimits.page - 1, feedLimits.page, feedLimits.page + 29])
      expect(markdown.split(`строка ${index}\n`).length - 1).toBe(1)
    await held.commit()
  })

  it('starts over from the first row when the late rows are more than a page', async () => {
    const taskId = await chat()
    const slow = await openWriter(
      taskId,
      Array.from({ length: feedLimits.page + 5 }, (_, index) => `медленная ${index}`),
    )
    await insertFeedEvent(db, { taskId, row: words('быстрая') })
    const first = await readAll(taskId, '0')
    expect(first.kept.size).toBe(1)
    await slow.commit()
    const answer = await read(taskId, first.cursor)
    expect(answer.cursor).toBe('0')
    expect(answer.more).toBe(true)
    const all = await readAll(taskId, answer.cursor, first.kept)
    expect(all.kept.size).toBe(feedLimits.page + 6)
  })
})
