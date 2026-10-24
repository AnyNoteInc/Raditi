import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import {
  closeBrowserSession,
  markBrowserSessionWrote,
  openBrowserSession,
} from './browser-sessions.ts'
import type { PrismaClient } from './generated/prisma/client.ts'
import { taskHasProductionWrites } from './task-production-writes.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)(
  'PostgreSQL: content writes a task left on the production site',
  () => {
    let schema: MigratedSchema
    let db: PrismaClient

    beforeAll(async () => {
      // A turn needs a row of agent_drivers: in a schema of its own the test neither depends on
      // the seeds of the database it was given nor leaves that row in it.
      schema = await createMigratedSchema(databaseUrl ?? '', 'production_writes')
      await schema.migrate()
      db = schemaClient(databaseUrl ?? '', schema)
      await db.agentDriver.upsert({
        where: { id: 'opencode' },
        update: {},
        create: { id: 'opencode', image: 'synthetic/agent:test', capabilities: {}, enabled: true },
      })
    }, 60_000)
    afterAll(async () => {
      await db?.$disconnect()
      await schema?.drop()
    })

    /** A task with one turn and the journal row of an applied write of its agent. */
    async function taskWithWrite(options: { preview?: boolean } = {}) {
      const at = new Date()
      const workspace = await db.workspace.create({ data: { name: 'Synthetic writes' } })
      const site = await db.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic',
          url: `https://${randomUUID()}.example.test`,
          stack: 'wordpress',
        },
      })
      const task = await db.task.create({ data: { workspaceId: workspace.id, siteId: site.id } })
      const turn = await db.taskTurn.create({
        data: { taskId: task.id, turnNo: 1, driverId: 'opencode', image: 'synthetic/agent:test' },
      })
      const assignment = await db.turnAssignment.create({
        data: {
          taskId: task.id,
          siteId: site.id,
          sessionId: 'synthetic-session',
          turnNo: 1,
          executor: 'local',
          plan: {},
          firstEpoch: 1,
          leaseEpoch: 1,
          deadlineAt: new Date(at.getTime() + 60_000),
          outcome: 'completed',
          finishedAt: at,
        },
      })
      const preview = options.preview
        ? await db.previewEnvironment.create({
            data: {
              siteId: site.id,
              taskId: task.id,
              hostname: `site-${randomUUID().slice(0, 8)}-chat-abcdef.localhost`,
              expiresAt: new Date(at.getTime() + 3600_000),
            },
          })
        : null
      const snapshot = await db.snapshot.create({
        data: {
          siteId: site.id,
          taskId: task.id,
          previewId: preview?.id ?? null,
          objectRef: 'page:42',
          s3Key: `snapshots/${randomUUID()}.json`,
          expiresAt: new Date(at.getTime() + 3600_000),
        },
      })
      const call = await db.mcpCall.create({
        data: {
          turnId: turn.id,
          tool: 'wp_rest',
          idempotencyKey: randomUUID(),
          assignmentId: assignment.id,
          credentialKeyId: randomUUID(),
          previewId: preview?.id ?? null,
          previewWriteEpoch: preview ? 0 : null,
          requestHash: 'a'.repeat(64),
          leaseEpoch: 1,
          writeStartedAt: at,
          appliedStateHash: 'b'.repeat(64),
          objectRef: 'page:42',
          snapshotId: snapshot.id,
          result: 'ok',
          response: {},
          finishedAt: at,
        },
      })
      return { taskId: task.id, callId: call.id }
    }

    it('finds an applied write of the agent until it is reverted', async () => {
      const { taskId, callId } = await taskWithWrite()
      expect(await taskHasProductionWrites(db, taskId)).toBe(true)
      // The writes of one turn: the undo before its replacement asks about that turn alone.
      expect(await taskHasProductionWrites(db, taskId, { turnNo: 1 })).toBe(true)
      expect(await taskHasProductionWrites(db, taskId, { turnNo: 2 })).toBe(false)

      await db.mcpCall.update({ where: { id: callId }, data: { revertedAt: new Date() } })
      expect(await taskHasProductionWrites(db, taskId)).toBe(false)
      expect(await taskHasProductionWrites(db, taskId, { turnNo: 1 })).toBe(false)
    })

    it('counts a click, input or upload in the browser of the task, never as one turn’s', async () => {
      const workspace = await db.workspace.create({ data: { name: 'Synthetic browser' } })
      const site = await db.site.create({
        data: {
          workspaceId: workspace.id,
          name: 'Synthetic',
          url: `https://${randomUUID()}.example.test`,
          stack: 'wordpress',
        },
      })
      const task = await db.task.create({
        data: {
          workspaceId: workspace.id,
          siteId: site.id,
          needsRepository: false,
          needsBrowser: true,
        },
      })
      const session = await openBrowserSession(db, { taskId: task.id })
      // Watched and closed without a write: the site was not touched.
      await closeBrowserSession(db, { sessionId: session.id, status: 'closed', reason: 'idle' })
      expect(await taskHasProductionWrites(db, task.id)).toBe(false)

      const next = await openBrowserSession(db, { taskId: task.id })
      await markBrowserSessionWrote(db, { sessionId: next.id })
      expect(await taskHasProductionWrites(db, task.id)).toBe(true)
      // What a browser did belongs to the task, not to a turn the undo could return.
      expect(await taskHasProductionWrites(db, task.id, { turnNo: 1 })).toBe(false)
    })

    it('does not count a write into the preview of the dialog, nor a task without writes', async () => {
      const { taskId } = await taskWithWrite({ preview: true })
      expect(await taskHasProductionWrites(db, taskId)).toBe(false)
      expect(await taskHasProductionWrites(db, randomUUID())).toBe(false)
    })
  },
)
