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

describe('a session as the store reads it (docs/plan/61-chats-first.md, К12)', () => {
  const sessionRow = (siteId: string | null, taskSite: string | null) => ({
    id: randomUUID(),
    taskId: randomUUID(),
    siteId,
    status: 'starting',
    expiresAt: new Date(),
    readyAt: null,
    lastActivityAt: new Date(),
    task: { siteId: taskSite },
  })
  const read = (found: ReturnType<typeof sessionRow> | null) =>
    new PostgresBrowserWorkerStore({
      browserSession: { findUnique: async () => found },
    } as unknown as PrismaClient).session(randomUUID())

  it('answers a session of a chat without a site, and the site of its task beside its own', async () => {
    await expect(read(sessionRow(null, null))).resolves.toMatchObject({
      siteId: null,
      taskSiteId: null,
    })
    const site = randomUUID()
    const other = randomUUID()
    const answer = await read(sessionRow(null, other))
    expect(answer).toMatchObject({ siteId: null, taskSiteId: other })
    expect(answer).not.toHaveProperty('task')
    await expect(read(sessionRow(site, site))).resolves.toMatchObject({
      siteId: site,
      taskSiteId: site,
    })
  })

  it('answers no session for no row', async () => {
    await expect(read(null)).resolves.toBeNull()
  })
})
