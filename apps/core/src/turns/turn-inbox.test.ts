import { Buffer } from 'node:buffer'

import type { Attachment } from '@repo/db'
import { attachmentKey, turnInboxPath } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

import { TaskInboxFiles } from './turn-inbox.ts'

const taskId = '0199a3f2-0000-7000-8000-0000000000a1'
const workspaceId = '0199a3f2-0000-7000-8000-0000000000b1'
const id = '0199a3f2-0000-7000-8000-0000000000f1'
const menu = Buffer.from('%PDF-1.7 synthetic menu')

const row = (change: Partial<Attachment> = {}): Attachment =>
  ({
    id,
    taskId,
    workspaceId,
    siteId: '0199a3f2-0000-7000-8000-0000000000c1',
    fileName: 'Меню.pdf',
    contentType: 'application/pdf',
    sizeBytes: menu.byteLength,
    s3Key: attachmentKey(workspaceId, id),
    status: 'bound',
    ...change,
  }) as Attachment

function fixture(found: Attachment | null = row(), stored: Uint8Array | null = menu) {
  const findFirst = vi.fn(async (_query: unknown) => found)
  const get = vi.fn(async (_bucket: string, _key: string) =>
    stored === null
      ? null
      : (async function* () {
          yield stored
        })(),
  )
  const inbox = new TaskInboxFiles({ attachment: { findFirst } } as never, { get } as never)
  return { inbox, findFirst, get }
}

const read = async (body: AsyncIterable<Uint8Array>) => {
  const chunks: Uint8Array[] = []
  for await (const chunk of body) chunks.push(chunk)
  return Buffer.concat(chunks)
}

describe('TaskInboxFiles', () => {
  const path = turnInboxPath(id, 'Меню.pdf')!

  it('gives a file bound to the task at its path, read from the inbox only when taken', async () => {
    const f = fixture()
    const [file] = await f.inbox.files(taskId, [path])
    expect(file).toMatchObject({ path, sizeBytes: menu.byteLength })
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { id, taskId, status: 'bound' },
    })
    expect(f.get).not.toHaveBeenCalled()
    expect(await read(file!.read())).toEqual(menu)
    expect(f.get).toHaveBeenCalledExactlyOnceWith('inbox', attachmentKey(workspaceId, id))
  })

  it.each([
    ['not bound to the task', null],
    ['renamed since the plan', row({ fileName: 'Другое.pdf' })],
    ['stored under another key', row({ s3Key: `inbox/${workspaceId}/other` })],
    ['larger than a file may be', row({ sizeBytes: 20 * 1024 * 1024 + 1 })],
  ])('refuses a file %s, reading nothing', async (_label, found) => {
    const f = fixture(found)
    await expect(f.inbox.files(taskId, [path])).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'A file of the turn is not bound to its task',
    })
    expect(f.get).not.toHaveBeenCalled()
  })

  it('refuses a path that names no attachment without asking the database', async () => {
    const f = fixture()
    await expect(f.inbox.files(taskId, ['/workspace/inbox/a.pdf'])).rejects.toMatchObject({
      code: 'CONFLICT',
    })
    expect(f.findFirst).not.toHaveBeenCalled()
  })

  it('fails the read of a file that is gone from the inbox', async () => {
    const f = fixture(row(), null)
    const [file] = await f.inbox.files(taskId, [path])
    await expect(read(file!.read())).rejects.toMatchObject({ code: 'CONFLICT' })
  })
})
