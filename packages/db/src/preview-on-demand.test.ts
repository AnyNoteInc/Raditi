import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { demandStoppedPreview } from './preview-on-demand.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)(
  'PostgreSQL: a preview built at the first need (docs/plan/82, Зп18)',
  () => {
    let schema: MigratedSchema
    let db: PrismaClient

    beforeAll(async () => {
      schema = await createMigratedSchema(databaseUrl ?? '', 'preview_on_demand')
      await schema.migrate()
      db = schemaClient(databaseUrl ?? '', schema)
    }, 60_000)
    afterAll(async () => {
      await db?.$disconnect()
      await schema?.drop()
    })

    async function preview(status: 'expired' | 'ready') {
      const workspace = await db.workspace.create({ data: { name: 'Synthetic demand' } })
      const site = await db.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic',
          url: `https://${randomUUID()}.example.test`,
          stack: 'wordpress',
        },
      })
      const task = await db.task.create({
        data: { workspaceId: workspace.id, siteId: site.id, status: 'running' },
      })
      return db.previewEnvironment.create({
        data: {
          siteId: site.id,
          taskId: task.id,
          status,
          dbMode: 'copy',
          hostname: `site-${randomUUID().slice(0, 8)}-chat-abcdef.localhost`,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      })
    }

    const jobs = (previewId: string) =>
      db.outboxEvent.findMany({
        where: { dedupeKey: { startsWith: `preview.sync:${previewId}:` } },
        select: { payload: true },
      })

    it('marks a stopped preview and queues one build while the demand is fresh', async () => {
      const row = await preview('expired')
      expect(row).toMatchObject({ lastViewedAt: null, enqueues: 1 })
      expect(await demandStoppedPreview(db, row.id)).toBe(true)
      // A screen or a tool that asks again on «not ready» adds no job.
      expect(await demandStoppedPreview(db, row.id)).toBe(false)
      const marked = await db.previewEnvironment.findUniqueOrThrow({ where: { id: row.id } })
      expect(marked.lastViewedAt).not.toBeNull()
      expect(marked.enqueues).toBe(2)
      expect((await jobs(row.id)).map((job) => job.payload)).toEqual([
        { previewId: row.id, revision: 0, seq: 2 },
      ])
      // A demand that went stale asks again.
      await db.$executeRaw`UPDATE preview_environments
      SET last_viewed_at = now() - interval '2 minutes' WHERE id = ${row.id}::uuid`
      expect(await demandStoppedPreview(db, row.id)).toBe(true)
      expect(await jobs(row.id)).toHaveLength(2)
    })

    it('asks nothing of a preview that is not stopped', async () => {
      const row = await preview('ready')
      expect(await demandStoppedPreview(db, row.id)).toBe(false)
      expect(await jobs(row.id)).toEqual([])
      expect(await demandStoppedPreview(db, randomUUID())).toBe(false)
    })
  },
)
