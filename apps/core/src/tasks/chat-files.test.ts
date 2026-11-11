import { Buffer } from 'node:buffer'

import { chatFileKey, feedRowSchema } from '@repo/domain'
import { packOutbox } from '@repo/snapshots'
import { describe, expect, it, vi } from 'vitest'

import { ChatFiles, chatFileId } from './chat-files.ts'

const taskId = '0199a3f2-0000-7000-8000-000000000001'
const turnId = '0199a3f2-0000-7000-8000-0000000000aa'

function side(existing: string[] = []) {
  const rows: Array<{ taskId: string; turnId: string | null; type: string; payload: unknown }> = []
  const known = new Set(existing)
  const db = {
    taskTurn: { findFirst: vi.fn(async () => ({ id: turnId })) },
    taskEvent: {
      findFirst: vi.fn(
        async ({ where }: { where: { type: string; payload?: { equals: string } } }) =>
          where.type === 'feed.file_left'
            ? rows.some((row) => row.type === 'feed.file_left')
              ? { id: 1n }
              : null
            : known.has(where.payload!.equals)
              ? { id: 1n }
              : null,
      ),
      create: vi.fn(
        async ({
          data,
        }: {
          data: { taskId: string; turnId: string | null; type: string; payload: unknown }
        }) => {
          rows.push(data)
          known.add((data.payload as { fileId?: string }).fileId ?? '')
          return { id: BigInt(rows.length) }
        },
      ),
    },
  }
  const objects = new Map<string, Buffer>()
  const storage = {
    put: vi.fn(
      async (_bucket: string, key: string, body: Uint8Array | AsyncIterable<Uint8Array>) => {
        objects.set(key, Buffer.from(body as Uint8Array))
      },
    ),
  }
  const logger = { log: vi.fn(), warn: vi.fn() }
  const files = new ChatFiles({ db: db as never, storage, logger })
  return { db, rows, objects, storage, logger, files }
}

describe('ChatFiles', () => {
  it('derives one id of version 8 per chat, turn and name', () => {
    const id = chatFileId(taskId, 2, 'a.txt')
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(chatFileId(taskId.toUpperCase(), 2, 'a.txt')).toBe(id)
    expect(chatFileId(taskId, 3, 'a.txt')).not.toBe(id)
    expect(chatFileId(taskId, 2, 'b.txt')).not.toBe(id)
  })

  it('puts every file into the artifacts bucket and writes its row under the turn', async () => {
    const s = side()
    const outbox = await packOutbox([
      { name: 'report.docx', bytes: 'docx bytes' },
      { name: 'data.xlsx', bytes: 'xlsx' },
    ])
    expect(await s.files.deliver({ taskId, turn: 2, outbox })).toBe(2)
    const docx = chatFileId(taskId, 2, 'report.docx')
    expect(s.objects.get(chatFileKey(taskId, docx))?.toString()).toBe('docx bytes')
    expect(s.storage.put).toHaveBeenCalledWith(
      'artifacts',
      chatFileKey(taskId, docx),
      expect.anything(),
      {
        contentType: 'application/octet-stream',
        sizeBytes: 10,
      },
    )
    expect(s.rows).toEqual([
      {
        taskId,
        turnId,
        type: 'feed.file',
        clientVisible: true,
        payload: { v: 1, fileId: docx, name: 'report.docx', sizeBytes: 10 },
      },
      expect.objectContaining({
        payload: expect.objectContaining({ name: 'data.xlsx', sizeBytes: 4 }),
      }),
    ])
    for (const row of s.rows)
      expect(feedRowSchema.safeParse({ type: row.type, payload: row.payload }).success).toBe(true)
    expect(s.logger.log).toHaveBeenCalledWith(`chat_files_delivered task=${taskId} turn=2 files=2`)
  })

  it('writes no second row when the delivery is repeated', async () => {
    const s = side()
    const outbox = await packOutbox([{ name: 'a.txt', bytes: 'x' }])
    await s.files.deliver({ taskId, turn: 1, outbox })
    expect(await s.files.deliver({ taskId, turn: 1, outbox })).toBe(0)
    expect(s.rows).toHaveLength(1)
    expect(s.storage.put).toHaveBeenCalledTimes(1)
  })

  it('never throws: an invalid archive or a failed upload is a line in the log', async () => {
    const s = side()
    expect(await s.files.deliver({ taskId, turn: 1, outbox: new Uint8Array([1, 2]) })).toBe(0)
    expect(s.logger.warn).toHaveBeenCalledWith(
      `chat_files_failed task=${taskId} turn=1 delivered=0 reason=BAD_REQUEST`,
    )
    expect(s.rows.map((row) => row.type)).toEqual(['feed.file_left'])
    const down = side()
    down.storage.put.mockRejectedValueOnce(new Error('s3 down'))
    expect(
      await down.files.deliver({
        taskId,
        turn: 1,
        outbox: await packOutbox([{ name: 'a.txt', bytes: 'x' }]),
      }),
    ).toBe(0)
    expect(down.logger.warn).toHaveBeenCalledWith(
      `chat_files_failed task=${taskId} turn=1 delivered=0 reason=unknown`,
    )
    // The agent's message speaks of the file all the same, so the client is told it did not come.
    expect(down.rows).toEqual([
      expect.objectContaining({
        type: 'feed.file_left',
        payload: { v: 1, reason: 'refused', count: 0 },
      }),
    ])
  })

  it('delivers a name of more than a hundred bytes (the chat of 11.11.2026)', async () => {
    const s = side()
    const name = 'Руководящий_состав_правительства_Смоленской_области.docx'
    expect(
      await s.files.deliver({ taskId, turn: 1, outbox: await packOutbox([{ name, bytes: 'd' }]) }),
    ).toBe(1)
    expect(s.rows).toEqual([
      expect.objectContaining({ type: 'feed.file', payload: expect.objectContaining({ name }) }),
    ])
  })

  it('tells the client what the capture left, after the files that came', async () => {
    const s = side()
    const outbox = await packOutbox([{ name: 'a.txt', bytes: 'x' }], { skipped: 2 })
    expect(await s.files.deliver({ taskId, turn: 1, outbox })).toBe(1)
    expect(s.rows.map((row) => row.type)).toEqual(['feed.file', 'feed.file_left'])
    expect(s.rows[1]).toMatchObject({
      turnId,
      clientVisible: true,
      payload: { v: 1, reason: 'skipped', count: 2 },
    })
    for (const row of s.rows)
      expect(feedRowSchema.safeParse({ type: row.type, payload: row.payload }).success).toBe(true)
    // Repeated, it adds nothing.
    await s.files.deliver({ taskId, turn: 1, outbox })
    expect(s.rows).toHaveLength(2)
  })

  it('tells the client when the files were refused whole', async () => {
    const s = side()
    expect(
      await s.files.deliver({ taskId, turn: 1, outbox: await packOutbox([], { refused: true }) }),
    ).toBe(0)
    expect(s.rows).toEqual([
      expect.objectContaining({
        type: 'feed.file_left',
        payload: { v: 1, reason: 'refused', count: 0 },
      }),
    ])
    expect(s.storage.put).not.toHaveBeenCalled()
  })

  it('says nothing when the folder was whole and every file came', async () => {
    const s = side()
    await s.files.deliver({
      taskId,
      turn: 1,
      outbox: await packOutbox([{ name: 'a.txt', bytes: 'x' }]),
    })
    expect(s.rows.map((row) => row.type)).toEqual(['feed.file'])
  })
})
