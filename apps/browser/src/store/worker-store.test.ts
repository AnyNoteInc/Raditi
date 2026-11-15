import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import { describe, expect, it } from 'vitest'

import { PostgresBrowserWorkerStore } from './worker-store.ts'

const row = () => ({
  id: randomUUID(),
  workspaceId: randomUUID(),
  s3Key: 'inbox/workspace/file',
  fileName: 'смета.pdf',
  contentType: 'application/pdf',
  sizeBytes: 3,
})

const storeOf = (found: ReturnType<typeof row>) =>
  new PostgresBrowserWorkerStore({
    attachment: { findFirst: async () => found },
  } as unknown as PrismaClient)

describe('a file of a task as the store reads it (docs/plan/61-chats-first.md, К16)', () => {
  it('answers a file of the chat', async () => {
    const found = row()
    await expect(
      storeOf(found).attachment({ id: found.id, taskId: randomUUID() }),
    ).resolves.toMatchObject({ id: found.id, s3Key: found.s3Key })
  })
})

describe('a session as the store reads it (docs/plan/61-chats-first.md, К12)', () => {
  const sessionRow = () => ({
    id: randomUUID(),
    taskId: randomUUID(),
    status: 'starting',
    expiresAt: new Date(),
    readyAt: null,
    lastActivityAt: new Date(),
  })
  const read = (found: ReturnType<typeof sessionRow> | null) =>
    new PostgresBrowserWorkerStore({
      browserSession: { findUnique: async () => found },
    } as unknown as PrismaClient).session(randomUUID())

  it('answers a session of a chat as its row has it', async () => {
    const found = sessionRow()
    await expect(read(found)).resolves.toEqual(found)
  })

  it('answers no session for no row', async () => {
    await expect(read(null)).resolves.toBeNull()
  })
})
