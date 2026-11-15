import { randomUUID } from 'node:crypto'

import { attachmentKey } from '@repo/domain'
import { describe, expect, it } from 'vitest'

import type { StoredAttachment } from '../store/worker-store.ts'
import { AttachmentFiles, type InboxStorage } from './attachments.ts'

const taskId = randomUUID()
const workspaceId = randomUUID()
const bytes = new Uint8Array([1, 2, 3])

function files() {
  const id = randomUUID()
  const row: StoredAttachment = {
    id,
    workspaceId,
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
  it('reads a file of the chat for its session', async () => {
    const { id, reader } = files()
    expect(await reader.read({ taskId, attachmentIds: [id] })).toEqual([
      { name: 'смета.pdf', mimeType: 'application/pdf', bytes },
    ])
  })
})
