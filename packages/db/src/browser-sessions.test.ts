import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  createMigratedSchema,
  schemaClient,
  type MigratedSchema,
} from '../prisma/migrated-schema.ts'
import {
  clearBrowserHelp,
  closeBrowserSession,
  listOpenBrowserSessions,
  markBrowserSessionReady,
  markBrowserSessionWrote,
  openBrowserSession,
  openBrowserSessionOfTask,
  recordBrowserControl,
  recordBrowserHelp,
  touchBrowserSession,
} from './browser-sessions.ts'
import type { PrismaClient, SiteStatus, TaskStatus } from './generated/prisma/client.ts'
import { uuidv7 } from './uuidv7.ts'

const databaseUrl = process.env.DATABASE_URL

describe.skipIf(!databaseUrl)('PostgreSQL: the browser session of a task', () => {
  let schema: MigratedSchema
  let db: PrismaClient

  beforeAll(async () => {
    schema = await createMigratedSchema(databaseUrl ?? '', 'browser_sessions')
    await schema.migrate()
    db = schemaClient(databaseUrl ?? '', schema)
  }, 60_000)
  afterAll(async () => {
    await db?.$disconnect()
    await schema?.drop()
  })

  /** A task of a site of its own; by default one in the browser alone, as the product makes. */
  async function browserTask(
    options: { needsBrowser?: boolean; status?: TaskStatus; siteStatus?: SiteStatus } = {},
  ) {
    const workspace = await db.workspace.create({
      data: { name: 'Synthetic browser', dataClass: 'synthetic' },
    })
    const site = await db.site.create({
      data: {
        workspaceId: workspace.id,
        name: 'Synthetic',
        url: `https://${randomUUID()}.example.test`,
        stack: 'wordpress',
        status: options.siteStatus ?? 'onboarding',
      },
    })
    const needsBrowser = options.needsBrowser ?? true
    return db.task.create({
      data: {
        workspaceId: workspace.id,
        siteId: site.id,
        needsRepository: !needsBrowser,
        needsBrowser,
        status: options.status ?? 'queued',
      },
    })
  }

  const seconds = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 1000

  it('opens one session per task, the same for two callers at once, on the task’s site', async () => {
    const task = await browserTask()
    const [first, second] = await Promise.all([
      openBrowserSession(db, { taskId: task.id }),
      openBrowserSession(db, { taskId: task.id }),
    ])
    expect(second.id).toBe(first.id)
    expect(first).toMatchObject({
      taskId: task.id,
      siteId: task.siteId,
      workspaceId: task.workspaceId,
      status: 'starting',
      controller: 'agent',
      controlEpoch: 0,
      viewportVersion: 1,
      helpReason: null,
      wroteAt: null,
      readyAt: null,
      closedAt: null,
    })
    // The hard deadline: four hours by default (browserSessionTimings.maxHours).
    expect(seconds(first.createdAt, first.expiresAt)).toBeGreaterThan(4 * 3600 - 5)
    expect(seconds(first.createdAt, first.expiresAt)).toBeLessThan(4 * 3600 + 5)
    expect(await db.browserSession.count({ where: { taskId: task.id } })).toBe(1)
    expect((await openBrowserSessionOfTask(db, task.id))?.id).toBe(first.id)

    const shorter = await openBrowserSession(db, { taskId: (await browserTask()).id, maxHours: 1 })
    expect(seconds(shorter.createdAt, shorter.expiresAt)).toBeLessThan(3600 + 5)
    await expect(openBrowserSession(db, { taskId: task.id, maxHours: 0 })).rejects.toThrow()
  })

  describe('the browser of a chat without a site (plan 61, К12)', () => {
    async function chat(options: { needsBrowser?: boolean; status?: TaskStatus } = {}) {
      const workspace = await db.workspace.create({
        data: { name: 'Synthetic chat', dataClass: 'synthetic' },
      })
      return db.task.create({
        data: {
          id: uuidv7(),
          workspaceId: workspace.id,
          siteId: null,
          needsRepository: false,
          needsBrowser: options.needsBrowser ?? true,
          status: options.status ?? 'queued',
        },
      })
    }

    it('opens a session with no site, once, in the workspace of the chat', async () => {
      const task = await chat()
      const [first, second] = await Promise.all([
        openBrowserSession(db, { taskId: task.id }),
        openBrowserSession(db, { taskId: task.id }),
      ])
      expect(second.id).toBe(first.id)
      expect(first).toMatchObject({
        taskId: task.id,
        siteId: null,
        workspaceId: task.workspaceId,
        status: 'starting',
      })
    })

    it('refuses a chat that needs no browser, and one that has ended', async () => {
      const plain = await chat({ needsBrowser: false })
      await expect(openBrowserSession(db, { taskId: plain.id })).rejects.toThrow(
        'The task does not need a browser',
      )
      const ended = await chat({ status: 'done' })
      await expect(openBrowserSession(db, { taskId: ended.id })).rejects.toThrow(
        'The task has ended',
      )
    })

    it('counts in the workspace with the sessions of its sites (К36)', async () => {
      const first = await chat()
      await openBrowserSession(db, { taskId: first.id })
      const site = await db.site.create({
        data: {
          workspaceId: first.workspaceId,
          name: 'Synthetic',
          url: `https://${randomUUID()}.example.test`,
          stack: 'wordpress',
        },
      })
      const task = await db.task.create({
        data: {
          workspaceId: first.workspaceId,
          siteId: site.id,
          needsRepository: false,
          needsBrowser: true,
        },
      })
      await openBrowserSession(db, { taskId: task.id })
      const third = await db.task.create({
        data: {
          id: uuidv7(),
          workspaceId: first.workspaceId,
          siteId: null,
          needsRepository: false,
          needsBrowser: true,
        },
      })
      await expect(openBrowserSession(db, { taskId: third.id })).rejects.toMatchObject({
        code: 'BROWSER_WORKSPACE_BUSY',
      })
    })
  })

  describe('the browsers of one workspace (plan 61, К36)', () => {
    /** A task of a site of its own in a workspace of a task already there. */
    async function neighbour(taskId: string) {
      const { workspaceId } = await db.task.findUniqueOrThrow({ where: { id: taskId } })
      const site = await db.site.create({
        data: {
          workspaceId,
          name: 'Synthetic',
          url: `https://${randomUUID()}.example.test`,
          stack: 'wordpress',
          status: 'onboarding',
        },
      })
      return db.task.create({
        data: { workspaceId, siteId: site.id, needsRepository: false, needsBrowser: true },
      })
    }

    it('refuses a third live browser, and takes it once one has closed', async () => {
      const first = await browserTask()
      const second = await neighbour(first.id)
      const third = await neighbour(first.id)
      const open = await db.$transaction((tx) => openBrowserSession(tx, { taskId: first.id }))
      await db.$transaction((tx) => openBrowserSession(tx, { taskId: second.id }))

      await expect(
        db.$transaction((tx) => openBrowserSession(tx, { taskId: third.id })),
      ).rejects.toMatchObject({ code: 'BROWSER_WORKSPACE_BUSY' })
      expect(await openBrowserSessionOfTask(db, third.id)).toBeNull()

      // A task that holds a browser keeps it whatever the count.
      const again = await db.$transaction((tx) => openBrowserSession(tx, { taskId: first.id }))
      expect(again.id).toBe(open.id)

      await closeBrowserSession(db, { sessionId: open.id, status: 'closed', reason: 'idle' })
      const taken = await db.$transaction((tx) => openBrowserSession(tx, { taskId: third.id }))
      expect(taken.status).toBe('starting')
    })

    it('counts under a lock: of three tasks at once two get a browser', async () => {
      const first = await browserTask()
      const tasks = [first, await neighbour(first.id), await neighbour(first.id)]
      const outcomes = await Promise.allSettled(
        tasks.map((task) => db.$transaction((tx) => openBrowserSession(tx, { taskId: task.id }))),
      )
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(2)
      expect(
        await db.browserSession.count({
          where: { workspaceId: first.workspaceId, status: { in: ['starting', 'ready'] } },
        }),
      ).toBe(2)
    })

    it('holds no other workspace to it', async () => {
      const first = await browserTask()
      await db.$transaction((tx) => openBrowserSession(tx, { taskId: first.id }))
      const elsewhere = await browserTask()
      const opened = await db.$transaction((tx) => openBrowserSession(tx, { taskId: elsewhere.id }))
      expect(opened.workspaceId).toBe(elsewhere.workspaceId)
    })
  })

  it('opens a session for a site being connected or connected, never a closed one', async () => {
    const active = await browserTask({ siteStatus: 'active' })
    expect((await openBrowserSession(db, { taskId: active.id })).status).toBe('starting')
    for (const siteStatus of ['paused', 'disconnected', 'archived'] as const) {
      const task = await browserTask({ siteStatus })
      await expect(openBrowserSession(db, { taskId: task.id })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'The site of the task is closed',
      })
    }
  })

  it('refuses a task that needs no browser, has ended or does not exist', async () => {
    const repository = await browserTask({ needsBrowser: false })
    await expect(openBrowserSession(db, { taskId: repository.id })).rejects.toMatchObject({
      code: 'CONFLICT',
      message: 'The task does not need a browser',
    })
    for (const status of ['done', 'failed', 'cancelled', 'rolled_back'] as const) {
      const task = await browserTask({ status })
      await expect(openBrowserSession(db, { taskId: task.id })).rejects.toMatchObject({
        code: 'CONFLICT',
        message: 'The task has ended',
      })
    }
    await expect(openBrowserSession(db, { taskId: randomUUID() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
    expect(await db.browserSession.count({ where: { taskId: { in: [repository.id] } } })).toBe(0)
  })

  it('records the life of a session while it holds a browser', async () => {
    const task = await browserTask()
    const { id: sessionId } = await openBrowserSession(db, { taskId: task.id })
    const row = () => db.browserSession.findUniqueOrThrow({ where: { id: sessionId } })

    expect(await markBrowserSessionReady(db, { sessionId })).toBe(true)
    const ready = await row()
    expect(ready).toMatchObject({ status: 'ready', readyAt: expect.any(Date) })
    // A second report changes nothing it said.
    expect(await markBrowserSessionReady(db, { sessionId })).toBe(true)
    expect((await row()).readyAt).toEqual(ready.readyAt)

    // The client takes the browser, the agent gets it back: the epoch only grows.
    expect(await recordBrowserControl(db, { sessionId, controller: 'user', controlEpoch: 1 })).toBe(
      true,
    )
    expect(await recordBrowserControl(db, { sessionId, controller: 'user', controlEpoch: 1 })).toBe(
      true,
    )
    expect(
      await recordBrowserControl(db, { sessionId, controller: 'agent', controlEpoch: 1 }),
    ).toBe(false)
    expect(
      await recordBrowserControl(db, { sessionId, controller: 'agent', controlEpoch: 0 }),
    ).toBe(false)
    expect(await row()).toMatchObject({ controller: 'user', controlEpoch: 1 })
    expect(
      await recordBrowserControl(db, { sessionId, controller: 'agent', controlEpoch: 3 }),
    ).toBe(true)
    expect(await row()).toMatchObject({ controller: 'agent', controlEpoch: 3 })
    await expect(
      recordBrowserControl(db, { sessionId, controller: 'agent', controlEpoch: -1 }),
    ).rejects.toThrow()

    expect(
      await recordBrowserHelp(db, { sessionId, reason: 'login', message: 'Войдите в админку' }),
    ).toBe(true)
    expect(await row()).toMatchObject({ helpReason: 'login', helpMessage: 'Войдите в админку' })
    await expect(
      recordBrowserHelp(db, { sessionId, reason: 'payment' as 'login', message: 'Оплатите' }),
    ).rejects.toThrow()
    await expect(
      recordBrowserHelp(db, { sessionId, reason: 'other', message: '' }),
    ).rejects.toThrow()
    expect(await clearBrowserHelp(db, { sessionId })).toBe(true)
    expect(await clearBrowserHelp(db, { sessionId })).toBe(false)
    expect(await row()).toMatchObject({ helpReason: null, helpMessage: null })

    const before = (await row()).lastActivityAt
    expect(await touchBrowserSession(db, { sessionId })).toBe(true)
    expect((await row()).lastActivityAt.getTime()).toBeGreaterThan(before.getTime())

    expect(await markBrowserSessionWrote(db, { sessionId })).toBe(true)
    const wrote = (await row()).wroteAt
    expect(wrote).toEqual(expect.any(Date))
    const latest = (await row()).lastWroteAt
    expect(latest!.getTime()).toBeGreaterThanOrEqual(wrote!.getTime())
    // The first write is kept: later ones change nothing it says.
    expect(await markBrowserSessionWrote(db, { sessionId })).toBe(true)
    expect((await row()).wroteAt).toEqual(wrote)
    // The first write of the session stays; the last one is of the latest pass.
    expect((await row()).lastWroteAt!.getTime()).toBeGreaterThanOrEqual(latest!.getTime())
  })

  it('closes only a session still starting when asked to: a browser that came up stays', async () => {
    const task = await browserTask()
    const { id: sessionId } = await openBrowserSession(db, { taskId: task.id })
    await markBrowserSessionReady(db, { sessionId })
    expect(
      await closeBrowserSession(db, {
        sessionId,
        status: 'failed',
        reason: 'crashed',
        errorCode: 'BROWSER_START_FAILED',
        onlyStarting: true,
      }),
    ).toMatchObject({ status: 'ready', closedAt: null, errorCode: null })

    const other = await browserTask()
    const opened = await openBrowserSession(db, { taskId: other.id })
    expect(
      await closeBrowserSession(db, {
        sessionId: opened.id,
        status: 'failed',
        reason: 'crashed',
        onlyStarting: true,
      }),
    ).toMatchObject({ status: 'failed', closeReason: 'crashed' })
  })

  it('closes a session once, and records nothing in it but its writes after', async () => {
    const task = await browserTask()
    const { id: sessionId } = await openBrowserSession(db, { taskId: task.id })
    await markBrowserSessionReady(db, { sessionId })

    const closed = await closeBrowserSession(db, {
      sessionId,
      status: 'closed',
      reason: 'task_done',
    })
    expect(closed).toMatchObject({
      status: 'closed',
      closeReason: 'task_done',
      closedAt: expect.any(Date),
      errorCode: null,
    })
    // The first close stands.
    expect(
      await closeBrowserSession(db, {
        sessionId,
        status: 'lost',
        reason: 'crashed',
        errorCode: 'WORKER_GONE',
      }),
    ).toMatchObject({ status: 'closed', closeReason: 'task_done', closedAt: closed!.closedAt })
    expect(
      await closeBrowserSession(db, { sessionId: randomUUID(), status: 'closed', reason: 'idle' }),
    ).toBeNull()
    await expect(
      closeBrowserSession(db, { sessionId, status: 'ready' as 'closed', reason: 'idle' }),
    ).rejects.toThrow()

    expect(await markBrowserSessionReady(db, { sessionId })).toBe(false)
    expect(await recordBrowserControl(db, { sessionId, controller: 'user', controlEpoch: 9 })).toBe(
      false,
    )
    expect(await recordBrowserHelp(db, { sessionId, reason: 'login', message: 'Войдите' })).toBe(
      false,
    )
    expect(await touchBrowserSession(db, { sessionId })).toBe(false)
    // A click that happened before the close came in: still a fact the task must tell.
    expect(await markBrowserSessionWrote(db, { sessionId })).toBe(true)
    expect(await openBrowserSessionOfTask(db, task.id)).toBeNull()

    // The next turn of the task opens a new one; the closed one stays as history.
    const next = await openBrowserSession(db, { taskId: task.id })
    expect(next.id).not.toBe(sessionId)
    expect(await db.browserSession.count({ where: { taskId: task.id } })).toBe(2)

    const failed = await closeBrowserSession(db, {
      sessionId: next.id,
      status: 'failed',
      reason: 'crashed',
      errorCode: 'BROWSER_LAUNCH_FAILED',
    })
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'BROWSER_LAUNCH_FAILED' })
  })

  it('lists the sessions that hold a browser, oldest first', async () => {
    const opened = []
    for (let index = 0; index < 3; index += 1)
      opened.push(await openBrowserSession(db, { taskId: (await browserTask()).id }))
    await closeBrowserSession(db, { sessionId: opened[1]!.id, status: 'lost', reason: 'crashed' })
    const listed = (await listOpenBrowserSessions(db)).map((session) => session.id)
    expect(listed).toContain(opened[0]!.id)
    expect(listed).toContain(opened[2]!.id)
    expect(listed).not.toContain(opened[1]!.id)
    expect(listed.indexOf(opened[0]!.id)).toBeLessThan(listed.indexOf(opened[2]!.id))
  })
})
