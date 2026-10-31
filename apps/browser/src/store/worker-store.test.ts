import { randomUUID } from 'node:crypto'

import type { PrismaClient } from '@repo/db'
import { describe, expect, it } from 'vitest'

import { PostgresBrowserWorkerStore } from './worker-store.ts'

const row = (siteId: string | null) => ({
  id: randomUUID(),
  workspaceId: randomUUID(),
  siteId,
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
  it('answers a file of a chat without a site, whose row has none', async () => {
    const found = row(null)
    await expect(
      storeOf(found).attachment({ id: found.id, taskId: randomUUID() }),
    ).resolves.toMatchObject({ id: found.id, siteId: null })
  })

  it('answers the site of any other file', async () => {
    const found = row(randomUUID())
    await expect(
      storeOf(found).attachment({ id: found.id, taskId: randomUUID() }),
    ).resolves.toMatchObject({ siteId: found.siteId })
  })
})
