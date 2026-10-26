import { describe, expect, it } from 'vitest'

import { FakeInbox, FakeStore } from '../testing/fakes.ts'
import { inboxOnly } from './attachments.ts'
import { TaskScreenshots } from './screenshots.ts'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])

describe('snapshots of a task in the inbox', () => {
  it('writes the image first, then the row that names it', async () => {
    const store = new FakeStore()
    const inbox = new FakeInbox()
    const row = store.open()
    const order: string[] = []
    const id = '0199a3f2-0000-7000-8000-0000000000e1'
    const recorder = {
      screenshotCount: (taskId: string) => store.screenshotCount(taskId),
      recordScreenshot: async (input: Parameters<FakeStore['recordScreenshot']>[0]) => {
        order.push('row')
        return store.recordScreenshot(input)
      },
    }
    const writer = {
      put: async (...args: Parameters<FakeInbox['put']>) => {
        order.push('put')
        return inbox.put(...args)
      },
    }
    const shots = new TaskScreenshots(recorder, writer, () => id)
    await expect(
      shots.save({ taskId: row.taskId, sessionId: row.id, bytes: JPEG, width: 2, height: 2 }),
    ).resolves.toEqual({ number: 1 })
    expect(order).toEqual(['put', 'row'])
    expect([...inbox.written.keys()]).toEqual([`screenshots/${row.taskId}/${id}.jpg`])
  })

  it('answers the session unavailable when the session ended before its row', async () => {
    const store = new FakeStore()
    const row = store.open()
    store.sessions.get(row.id)!.status = 'closed'
    const shots = new TaskScreenshots(store, new FakeInbox())
    await expect(
      shots.save({ taskId: row.taskId, sessionId: row.id, bytes: JPEG, width: 2, height: 2 }),
    ).rejects.toMatchObject({ code: 'BROWSER_SESSION_UNAVAILABLE' })
  })

  it('lets the worker write snapshots of the inbox alone, never an attachment', async () => {
    const inner = new FakeInbox()
    const inbox = inboxOnly(inner)
    await inbox.put('inbox', 'screenshots/a/b.jpg', JPEG)
    expect(inner.written.has('screenshots/a/b.jpg')).toBe(true)
    for (const [bucket, key] of [
      ['inbox', 'inbox/workspace/attachment'],
      ['inbox', 'screenshots/../inbox/x'],
      ['artifacts', 'screenshots/a/b.jpg'],
    ] as const)
      await expect(inbox.put(bucket, key, JPEG)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})
