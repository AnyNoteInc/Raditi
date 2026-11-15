import { createHash, randomBytes, randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import { Test } from '@nestjs/testing'
import { createPrismaClient, type PrismaClient } from '@repo/db'
import { browserSessionLimits } from '@repo/domain'
import request from 'supertest'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { PRISMA, SECRET_STORE } from '@repo/service-runtime'
import { fakeInfra, notDocTool, testMcpConfig } from '../testing/fakes.ts'
import { PostgresMcpAccess } from './mcp-access.ts'
import { AppModule } from '../app.module.ts'
import { mountMcp } from '../server/mount-mcp.ts'
import { mcpBrowserTasksOf } from '../site-info/browser-tasks.ts'
import { PostgresMcpWebStore } from '../web/mcp-web-store.ts'

const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const hash = (value: string) => createHash('sha256').update(value).digest('hex')

// A turn of a chat (docs/plan/83-remove-projects.md, БП1): no site, no preview; the turn holds
// the row of `site_leases` named by the chat's own id.
describe.skipIf(!enabled)('MCP admission and HTTP with PostgreSQL', () => {
  let db: PrismaClient
  let app: INestApplication | undefined
  let store: PostgresMcpAccess
  let fixture: {
    workspaceId: string
    driverId: string
    providerId: string
    modelId: string
    credentialId: string
    accountId: string
  }

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    store = new PostgresMcpAccess(db)
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  beforeEach(async () => {
    const suffix = randomBytes(8).toString('hex')
    fixture = await db.$transaction(async (tx) => {
      const workspace = await tx.workspace.create({
        data: { name: 'Synthetic MCP', dataClass: 'synthetic' },
      })
      const driver = await tx.agentDriver.create({
        data: {
          id: `mcp-${suffix}`,
          image: `synthetic@sha256:${'a'.repeat(64)}`,
          capabilities: {},
          enabled: true,
        },
      })
      const provider = await tx.llmProvider.create({
        data: { slug: `mcp-${suffix}`, name: 'Synthetic', kind: 'subscription' },
      })
      const model = await tx.llmModel.create({
        data: {
          providerId: provider.id,
          slug: `mcp-${suffix}`,
          name: 'Synthetic',
          modelClass: 'standard',
          reserveOutputTokens: 1024,
        },
      })
      const credential = await tx.credentialRef.create({
        data: { kind: 'subscription', vaultPath: `subs/synthetic/${suffix}` },
      })
      const account = await tx.subscriptionAccount.create({
        data: {
          providerId: provider.id,
          driverId: driver.id,
          label: `mcp-${suffix}`,
          plan: 'synthetic',
          credentialRefId: credential.id,
          maxConcurrentTurns: 1,
          maxConcurrentRequests: 1,
        },
      })
      return {
        workspaceId: workspace.id,
        driverId: driver.id,
        providerId: provider.id,
        modelId: model.id,
        credentialId: credential.id,
        accountId: account.id,
      }
    })
  })

  afterEach(async () => {
    await app?.close()
    app = undefined
    await db.workspace.delete({ where: { id: fixture.workspaceId } })
    await db.subscriptionAccount.delete({ where: { id: fixture.accountId } })
    await db.credentialRef.delete({ where: { id: fixture.credentialId } })
    await db.llmModel.delete({ where: { id: fixture.modelId } })
    await db.llmProvider.delete({ where: { id: fixture.providerId } })
    await db.agentDriver.delete({ where: { id: fixture.driverId } })
  })

  /** The key, the assignment and the lease of the first turn of a chat, under its own id. */
  async function liveTurn(taskId: string, suffix: string, token: string) {
    const key = await db.llmKey.create({
      data: {
        keyHash: hash(randomUUID()),
        mcpTokenHash: hash(token),
        taskId,
        taskAttempt: 1,
        sessionId: suffix,
        turnNo: 1,
        firstEpoch: 1,
        driverId: fixture.driverId,
        modelId: fixture.modelId,
        subscriptionAccountId: fixture.accountId,
        budgetRub: '100',
        issuedAt: new Date(Date.now() - 60_000),
        expiresAt: new Date(Date.now() + 300_000),
        validUntil: new Date(Date.now() + 600_000),
      },
    })
    const assignment = await db.turnAssignment.create({
      data: {
        taskId,
        siteId: taskId,
        sessionId: suffix,
        turnNo: 1,
        executor: 'local',
        plan: {},
        firstEpoch: 1,
        leaseEpoch: 1,
        deadlineAt: new Date(Date.now() + 600_000),
      },
    })
    await db.siteLease.create({
      data: {
        siteId: taskId,
        holderTaskId: taskId,
        epoch: 1,
        operation: 'turn',
        expiresAt: new Date(Date.now() + 600_000),
      },
    })
    const cleanup = async () => {
      await db.browserSession.deleteMany({ where: { taskId } })
      await db.llmKey.deleteMany({ where: { taskId } })
      await db.siteLease.deleteMany({ where: { siteId: taskId } })
      await db.turnAssignment.deleteMany({ where: { taskId } })
      await db.task.delete({ where: { id: taskId } })
    }
    return { key, assignment, cleanup }
  }

  /** A turn of a chat, under the lease of its own id (plan 61, К14). */
  async function chatTurnOf(needsBrowser: boolean) {
    const suffix = randomBytes(8).toString('hex')
    const token = `mcp_${randomBytes(32).toString('hex')}`
    const task = await db.task.create({
      data: {
        workspaceId: fixture.workspaceId,
        status: 'running',
        needsRepository: false,
        needsBrowser,
      },
    })
    return { token, task, ...(await liveTurn(task.id, suffix, token)) }
  }

  async function ensureJobs(sessionId: string) {
    return db.outboxEvent.findMany({
      where: {
        topic: 'browser-sessions',
        dedupeKey: { startsWith: `browser.ensure:${sessionId}:` },
      },
    })
  }

  async function serve(token: string) {
    const module = await Test.createTestingModule({
      imports: [AppModule.forRoot(testMcpConfig())],
    })
      .overrideProvider(PRISMA)
      .useValue(db)
      .overrideProvider(SECRET_STORE)
      .useValue(fakeInfra().secrets)
      .compile()
    app = module.createNestApplication({ logger: false })
    await mountMcp(app)
    await app.listen(0, '127.0.0.1')
    return (body: unknown) =>
      request(app!.getHttpServer())
        .post('/mcp')
        .set('Authorization', `Bearer ${token}`)
        .set('Accept', 'application/json, text/event-stream')
        .set('mcp-protocol-version', '2025-06-18')
        .send(body as object)
  }

  it.each([false, true])(
    'admits a turn of a chat, browser %s, by its own lease',
    async (browser) => {
      const turn = await chatTurnOf(browser)
      try {
        expect(await store.authenticate(turn.token)).toEqual({
          keyId: turn.key.id,
          taskId: turn.task.id,
          workspaceId: fixture.workspaceId,
          sessionId: turn.assignment.sessionId,
          turn: 1,
          firstEpoch: 1,
          epoch: 1,
          requirements: { repository: false, browser },
        })
      } finally {
        await turn.cleanup()
      }
    },
  )

  it('admits two chats at once, each by its own lease', async () => {
    const one = await chatTurnOf(false)
    const other = await chatTurnOf(false)
    try {
      expect(await store.authenticate(one.token)).toMatchObject({ taskId: one.task.id })
      expect(await store.authenticate(other.token)).toMatchObject({ taskId: other.task.id })
    } finally {
      await one.cleanup()
      await other.cleanup()
    }
  })

  it('refuses a stale epoch, a lease of another chat, a revoked key and a finished turn', async () => {
    const turn = await chatTurnOf(false)
    const other = await chatTurnOf(false)
    const lease = { siteId: turn.task.id }
    try {
      await db.siteLease.update({ where: lease, data: { epoch: 2 } })
      expect(await store.authenticate(turn.token)).toBeNull()
      await db.siteLease.update({ where: lease, data: { epoch: 1, holderTaskId: other.task.id } })
      expect(await store.authenticate(turn.token)).toBeNull()
      await db.siteLease.update({ where: lease, data: { holderTaskId: turn.task.id } })
      expect(await store.authenticate(turn.token)).not.toBeNull()
      // Its assignment names the lease of another chat, which it does not hold.
      await db.turnAssignment.update({
        where: { id: turn.assignment.id },
        data: { siteId: other.task.id },
      })
      expect(await store.authenticate(turn.token)).toBeNull()
      await db.turnAssignment.update({
        where: { id: turn.assignment.id },
        data: { siteId: turn.task.id },
      })
      await db.task.update({ where: { id: turn.task.id }, data: { status: 'done' } })
      expect(await store.authenticate(turn.token)).toBeNull()
      await db.task.update({ where: { id: turn.task.id }, data: { status: 'running' } })
      await db.turnAssignment.update({
        where: { id: turn.assignment.id },
        data: { finishedAt: new Date(), outcome: 'completed' },
      })
      expect(await store.authenticate(turn.token)).toBeNull()
    } finally {
      await turn.cleanup()
      await other.cleanup()
    }
  })

  it('enforces the paired hash format and uniqueness in PostgreSQL', async () => {
    const turn = await chatTurnOf(false)
    try {
      await expect(
        db.llmKey.update({ where: { id: turn.key.id }, data: { mcpTokenHash: 'g'.repeat(64) } }),
      ).rejects.toThrow()
      const key = await db.llmKey.findUniqueOrThrow({ where: { id: turn.key.id } })
      await expect(
        db.llmKey.create({
          data: { ...key, id: randomUUID(), keyHash: hash(randomUUID()), turnNo: 2 },
        }),
      ).rejects.toThrow()
      expect(await store.authenticate(turn.token)).not.toBeNull()
    } finally {
      await turn.cleanup()
    }
  })

  it.each([
    [false, null],
    [true, { siteUrl: null, startPath: null, controller: 'agent' }],
  ])(
    'offers site_info alone, with nulls, and stops on revocation: browser %s',
    async (needs, browser) => {
      const turn = await chatTurnOf(needs)
      if (needs)
        await db.browserSession.create({
          data: {
            taskId: turn.task.id,
            workspaceId: fixture.workspaceId,
            status: 'ready',
            readyAt: new Date(),
            controller: 'agent',
            controlEpoch: 1,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        })
      const post = await serve(turn.token)
      try {
        const list = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
        expect(list.status).toBe(200)
        expect(
          list.body.result.tools.map((tool: { name: string }) => tool.name).filter(notDocTool),
        ).toEqual(['site_info'])
        const info = await post({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'site_info', arguments: {} },
        })
        expect(JSON.parse(info.body.result.content[0].text)).toEqual({
          stack: null,
          url: null,
          siteUrl: null,
          browser,
        })
        await db.llmKey.update({
          where: { id: turn.key.id },
          data: { revokeRequestedAt: new Date() },
        })
        expect((await post({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).status).toBe(401)
        expect(JSON.stringify(info.body)).not.toContain(turn.token)
      } finally {
        await app?.close()
        app = undefined
        await turn.cleanup()
      }
    },
  )

  it('admits a web call only with the open browser session of the task, and marks its content', async () => {
    const turn = await chatTurnOf(true)
    const web = new PostgresMcpWebStore(db, { maxHours: 4 })
    // What site_info tells of the browser reads the same session.
    const browserTasks = mcpBrowserTasksOf({ db })
    try {
      const scope = (await store.authenticate(turn.token))!
      expect(await browserTasks.controller(turn.task.id)).toBeNull()
      // No session yet: the first call opens one and asks core for it, in one transaction (К11).
      const first = await web.admit(scope)
      expect(first.session.status).toBe('starting')
      const session = await db.browserSession.findUniqueOrThrow({
        where: { id: first.session.id },
      })
      expect(session).toMatchObject({
        taskId: turn.task.id,
        siteId: null,
        workspaceId: fixture.workspaceId,
        status: 'starting',
      })
      expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeGreaterThan(
        3 * 3_600_000,
      )
      expect(await ensureJobs(session.id)).toEqual([
        expect.objectContaining({
          topic: 'browser-sessions',
          type: 'browser.ensure',
          payload: { taskId: turn.task.id, sessionId: session.id },
        }),
      ])
      expect(await web.sessionState(session.id)).toBe('starting')
      // While it starts, a call asks again once a window: its job may have been lost.
      expect((await web.admit(scope)).session).toEqual({ id: session.id, status: 'starting' })
      expect((await ensureJobs(session.id)).length).toBeLessThanOrEqual(2)
      await db.browserSession.update({
        where: { id: session.id },
        data: { status: 'ready', readyAt: new Date(), controller: 'user', controlEpoch: 1 },
      })
      const asked = (await ensureJobs(session.id)).length
      const admission = await web.admit(scope)
      expect(admission).toMatchObject({
        assignmentId: turn.assignment.id,
        session: { id: session.id, status: 'ready' },
      })
      expect(admission.deadlineAt.getTime()).toBeGreaterThan(admission.now.getTime())
      expect(await browserTasks.controller(turn.task.id)).toBe('user')
      expect(await ensureJobs(session.id)).toHaveLength(asked)
      // What a page shows is content of the task: its contact map is swept with it.
      expect(
        (await db.task.findUniqueOrThrow({ where: { id: turn.task.id } })).contentAccessedAt,
      ).not.toBeNull()
      // The same conditions as the admission: a turn that ended, a closed session.
      await db.turnAssignment.update({
        where: { id: turn.assignment.id },
        data: { finishedAt: new Date(), outcome: 'completed' },
      })
      await expect(web.admit(scope)).rejects.toMatchObject({ code: 'BROWSER_SESSION_UNAVAILABLE' })
      await db.turnAssignment.update({
        where: { id: turn.assignment.id },
        data: { finishedAt: null, outcome: null },
      })
      const close = (id: string) =>
        db.browserSession.update({
          where: { id },
          data: { status: 'closed', closedAt: new Date(), closeReason: 'crashed' },
        })
      await close(session.id)
      expect(await web.sessionState(session.id)).toBe('closed')
      // One replacement in an assignment (К41): a third browser is not started for it.
      const replacement = await web.admit(scope)
      expect(replacement.session.id).not.toBe(session.id)
      expect(replacement.session.status).toBe('starting')
      await close(replacement.session.id)
      await expect(web.admit(scope)).rejects.toMatchObject({ code: 'BROWSER_SESSION_UNAVAILABLE' })
      expect(await db.browserSession.count({ where: { taskId: turn.task.id } })).toBe(2)
      // Sessions of an earlier assignment are not this one's to count.
      await db.browserSession.updateMany({
        where: { taskId: turn.task.id },
        data: { createdAt: new Date(Date.now() - 3_600_000) },
      })
      expect((await web.admit(scope)).session.status).toBe('starting')
      await expect(web.sessionState(randomUUID())).resolves.toBeNull()
    } finally {
      await db.outboxEvent.deleteMany({ where: { topic: 'browser-sessions' } })
      await turn.cleanup()
    }
  })

  it('tells the agent the workspace holds all its browsers', async () => {
    const turn = await chatTurnOf(true)
    const web = new PostgresMcpWebStore(db, { maxHours: 4 })
    const others = await Promise.all(
      Array.from({ length: browserSessionLimits.perWorkspace }, () =>
        db.task.create({
          data: {
            workspaceId: fixture.workspaceId,
            needsRepository: false,
            needsBrowser: true,
          },
        }),
      ),
    )
    try {
      for (const other of others)
        await db.browserSession.create({
          data: {
            taskId: other.id,
            workspaceId: fixture.workspaceId,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
        })
      const scope = (await store.authenticate(turn.token))!
      await expect(web.admit(scope)).rejects.toMatchObject({ code: 'BROWSER_WORKSPACE_BUSY' })
      expect(await db.browserSession.count({ where: { taskId: turn.task.id } })).toBe(0)
    } finally {
      await db.browserSession.deleteMany({ where: { taskId: { in: others.map(({ id }) => id) } } })
      await db.task.deleteMany({ where: { id: { in: others.map(({ id }) => id) } } })
      await turn.cleanup()
    }
  })

  it('refuses a web call of a chat that needs no browser, whatever its scope says', async () => {
    const turn = await chatTurnOf(false)
    const web = new PostgresMcpWebStore(db, { maxHours: 4 })
    try {
      const scope = (await store.authenticate(turn.token))!
      await expect(
        web.admit({ ...scope, requirements: { repository: false, browser: true } }),
      ).rejects.toMatchObject({ code: 'BROWSER_SESSION_UNAVAILABLE' })
    } finally {
      await turn.cleanup()
    }
  })

  it("knows the files sent with the task's messages, and no other", async () => {
    const turn = await chatTurnOf(true)
    const other = await chatTurnOf(false)
    const web = new PostgresMcpWebStore(db, { maxHours: 4 })
    try {
      const file = (taskId: string | null) => {
        const id = randomUUID()
        return db.attachment.create({
          data: {
            id,
            workspaceId: fixture.workspaceId,
            taskId,
            source: 'web',
            status: taskId === null ? 'ready' : 'bound',
            s3Key: `inbox/${fixture.workspaceId}/${id}`,
            fileName: 'photo.jpg',
            contentType: 'image/jpeg',
            sizeBytes: 1024,
            expiresAt: new Date(Date.now() + 3_600_000),
            boundAt: taskId === null ? null : new Date(),
          },
        })
      }
      const sent = await file(turn.task.id)
      const unsent = await file(null)
      expect(await web.attachmentsOfTask(turn.task.id, [sent.id])).toBe(true)
      expect(await web.attachmentsOfTask(turn.task.id, [sent.id, unsent.id])).toBe(false)
      // A file of another task is not this one's, whoever names it.
      expect(await web.attachmentsOfTask(other.task.id, [sent.id])).toBe(false)
    } finally {
      await db.attachment.deleteMany({ where: { taskId: turn.task.id } })
      await turn.cleanup()
      await other.cleanup()
    }
  })
})
