import { randomUUID } from 'node:crypto'

import { attachmentKey } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import type { StoredAttachment } from '../store/worker-store.ts'
import { AttachmentFiles, type InboxStorage } from './attachments.ts'

const taskId = randomUUID()
const workspaceId = randomUUID()
const bytes = new Uint8Array([1, 2, 3])

function files(siteId: string | null) {
  const id = randomUUID()
  const row: StoredAttachment = {
    id,
    workspaceId,
    siteId,
    s3Key: attachmentKey(workspaceId, id),
    fileName: 'смета.pdf',
    contentType: 'application/pdf',
    sizeBytes: bytes.byteLength,
  }
  const inbox = {
    get: async () =>
      (async function* () {
        yield bytes
      })(),
  } as unknown as InboxStorage
  return { id, reader: new AttachmentFiles({ attachment: async () => row }, inbox) }
}

describe('files of a task for a page of its browser (docs/plan/61-chats-first.md, К16)', () => {
  it('reads a file of a chat without a site for the session without one', async () => {
    const { id, reader } = files(null)
    expect(await reader.read({ taskId, siteId: null, attachmentIds: [id] })).toEqual([
      { name: 'смета.pdf', mimeType: 'application/pdf', bytes },
    ])
  })

  it('reads a file of the site for the session of that site', async () => {
    const siteId = randomUUID()
    const { id, reader } = files(siteId)
    await expect(reader.read({ taskId, siteId, attachmentIds: [id] })).resolves.toHaveLength(1)
  })

  it.each([
    ['a file of a site for a session without one', randomUUID(), null],
    ['a file without a site for a session of a site', null, randomUUID()],
    ['a file of another site', randomUUID(), randomUUID()],
  ])('refuses %s', async (_label, ofFile, ofSession) => {
    const { id, reader } = files(ofFile)
    await expect(
      reader.read({ taskId, siteId: ofSession, attachmentIds: [id] }),
    ).rejects.toMatchObject({ code: 'BROWSER_ATTACHMENT_UNKNOWN' })
  })
})
