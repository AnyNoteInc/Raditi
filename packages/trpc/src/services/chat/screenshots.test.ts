import type { PrismaClient } from '@repo/db'
import { describe, expect, it, vi } from 'vitest'

import { readTaskScreenshot } from './screenshots.ts'

const userId = '0199a3f2-0000-7000-8000-0000000000a1'
const taskId = '0199a3f2-0000-7000-8000-0000000000b1'
const screenshotId = '0199a3f2-0000-7000-8000-0000000000c1'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10])

function setup(options: { task?: boolean; row?: boolean; object?: Uint8Array | null } = {}) {
  const db = {
    task: {
      findFirst: vi.fn(async () => (options.task === false ? null : { id: taskId })),
    },
    taskEvent: {
      findFirst: vi.fn(async () => (options.row === false ? null : { id: 7n })),
    },
  }
  const object = options.object === undefined ? JPEG : options.object
  const storage = {
    get: vi.fn(async () =>
      object === null
        ? null
        : (async function* () {
            yield object
          })(),
    ),
  }
  const read = (ids: Partial<{ taskId: string; screenshotId: string }> = {}) =>
    readTaskScreenshot(db as unknown as Pick<PrismaClient, 'task' | 'taskEvent'>, storage, {
      userId,
      taskId,
      screenshotId,
      ...ids,
    })
  return { db, storage, read }
}

describe('readTaskScreenshot', () => {
  it('reads the JPEG a row of the dialog names, for a member of the task, from the inbox', async () => {
    const { db, storage, read } = setup()
    expect([...((await read()) ?? [])]).toEqual([...JPEG])
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
        where: {
          taskId,
          type: 'feed.screenshot',
          payload: { path: ['screenshotId'], equals: screenshotId },
        },
      }),
    ])
    expect(storage.get).toHaveBeenCalledWith('inbox', `screenshots/${taskId}/${screenshotId}.jpg`)
  })

  it('answers null for another task, an id no row names, a bad id and a missing image', async () => {
    expect(await setup({ task: false }).read()).toBeNull()
    expect(await setup({ row: false }).read()).toBeNull()
    expect(await setup({ object: null }).read()).toBeNull()
    const { storage, read } = setup()
    expect(await read({ screenshotId: '../inbox/x' })).toBeNull()
    expect(await read({ taskId: 'task' })).toBeNull()
    expect(storage.get).not.toHaveBeenCalled()
  })

  it('serves only a JPEG within its limit', async () => {
    expect(await setup({ object: new TextEncoder().encode('<svg/>') }).read()).toBeNull()
    expect(await setup({ object: new Uint8Array(1024 * 1024 + 1).fill(0xff) }).read()).toBeNull()
  })
})
