import type { PrismaClient } from '@repo/db'
import { describe, expect, it, vi } from 'vitest'

import { readTaskFile } from './files.ts'

const userId = '0199a3f2-0000-7000-8000-0000000000a1'
const taskId = '0199a3f2-0000-7000-8000-0000000000b1'
const fileId = '0199a3f2-0000-8000-8000-0000000000f1'
const BODY = new TextEncoder().encode('docx bytes')
const payload = { v: 1, fileId, name: 'Отчёт.docx', sizeBytes: BODY.byteLength }

function setup(options: { task?: boolean; row?: unknown; object?: Uint8Array | null } = {}) {
  const db = {
    task: { findFirst: vi.fn(async () => (options.task === false ? null : { id: taskId })) },
    taskEvent: {
      findFirst: vi.fn(async () =>
        options.row === null
          ? null
          : { payload: options.row === undefined ? payload : options.row },
      ),
    },
  }
  const object = options.object === undefined ? BODY : options.object
  const storage = {
    get: vi.fn(async () =>
      object === null
        ? null
        : (async function* () {
            yield object
          })(),
    ),
  }
  const read = (ids: Partial<{ taskId: string; fileId: string }> = {}) =>
    readTaskFile(db as unknown as Pick<PrismaClient, 'task' | 'taskEvent'>, storage, {
      userId,
      taskId,
      fileId,
      ...ids,
    })
  return { db, storage, read }
}

describe('readTaskFile', () => {
  it('reads the file a row of the chat names, for a member of the task, from the artifacts', async () => {
    const { db, storage, read } = setup()
    const file = await read()
    expect(file?.name).toBe('Отчёт.docx')
    expect([...(file?.bytes ?? [])]).toEqual([...BODY])
    expect(db.task.findFirst.mock.calls[0]).toEqual([
      expect.objectContaining({
        where: expect.objectContaining({
          id: taskId,
          workspace: { members: { some: { userId } } },
        }),
      }),
    ])
    expect(db.taskEvent.findFirst.mock.calls[0]).toEqual([
      expect.objectContaining({
        where: { taskId, type: 'feed.file', payload: { path: ['fileId'], equals: fileId } },
      }),
    ])
    expect(storage.get).toHaveBeenCalledWith('artifacts', `chat-files/${taskId}/${fileId}`)
  })

  it('answers null for another task, an id no row names, a bad id or row and a missing object', async () => {
    expect(await setup({ task: false }).read()).toBeNull()
    expect(await setup({ row: null }).read()).toBeNull()
    expect(await setup({ row: { ...payload, name: '../x' } }).read()).toBeNull()
    expect(await setup({ object: null }).read()).toBeNull()
    const { storage, read } = setup()
    expect(await read({ fileId: '../artifacts/x' })).toBeNull()
    expect(await read({ taskId: 'task' })).toBeNull()
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('serves only an object of the size its row says', async () => {
    expect(await setup({ object: new Uint8Array(BODY.byteLength + 1) }).read()).toBeNull()
    expect(await setup({ object: new Uint8Array(BODY.byteLength - 1) }).read()).toBeNull()
  })
})
