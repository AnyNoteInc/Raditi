import { ensurePersonalWorkspaceWithGift } from '@repo/billing'
import { billingFixtures } from '@repo/billing/testing'
import {
  createPrismaClient,
  openBrowserSession,
  recordBrowserHelp,
  type PrismaClient,
} from '@repo/db'
import type { BrowserSessionState } from '@repo/domain'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { BROWSER_ENSURE_GRACE_MS, BrowserSessions } from './browser-sessions.ts'

// The cloud browser of a task as core keeps it in PostgreSQL (docs/plan/57-browser-tasks.md,
// Б16, Б18), against a stand-in of the worker. The collector reads every open session of the
// database: only on a disposable one (RADITI_GATEWAY_DB_TESTS).
const databaseUrl = process.env.DATABASE_URL
const enabled = Boolean(databaseUrl && process.env.RADITI_GATEWAY_DB_TESTS === '1')
const quiet = { log: vi.fn(), warn: vi.fn() }

describe.skipIf(!enabled)('the browsers of tasks with PostgreSQL', () => {
  let db: PrismaClient
  let fixtures: ReturnType<typeof billingFixtures>

  beforeAll(() => {
    db = createPrismaClient({ databaseUrl: databaseUrl ?? '', log: [] })
    fixtures = billingFixtures(db)
  })
  afterEach(async () => {
    await fixtures.cleanup()
    vi.clearAllMocks()
  })
  afterAll(async () => {
    await db.$disconnect()
  })

  async function browserTask(status = 'preparing') {
    const { userId } = await fixtures.user()
    const workspace = await db.$transaction((tx) =>
      ensurePersonalWorkspaceWithGift(tx, { userId, appEnv: 'test' }),
    )
    const { taskId } = await fixtures.task(workspace.id, {
      status: status as never,
      needsRepository: false,
      needsBrowser: true,
    })
    const task = await db.task.findUniqueOrThrow({ where: { id: taskId } })
    await db.site.update({ where: { id: task.siteId }, data: { agentNotes: 'Вход по /login' } })
    return task
  }

  function worker() {
    const live = new Set<string>()
    const client = {
      ensure: vi.fn(async (request: { sessionId: string }) => {
        live.add(request.sessionId)
        return {
          session: request.sessionId,
          status: 'ready',
          controller: 'agent',
          controlEpoch: 1,
          manualReady: false,
          holder: null,
          pageId: 1,
          viewportVersion: 1,
          viewport: { width: 1280, height: 800 },
          url: 'https://example.ru/wp-admin/edit.php',
          title: 'Записи',
          tabs: [],
        } satisfies BrowserSessionState
      }),
      close: vi.fn(async (sessionId: string) => {
        live.delete(sessionId)
        return { sessionId, status: 'closed' as const }
      }),
      verify: vi.fn(async () => ({ checkpoints: [] })),
      list: vi.fn(async () => ({
        sessions: [...live].map((sessionId) => ({
          sessionId,
          taskId: '00000000-0000-4000-8000-000000000000',
          status: 'ready' as const,
        })),
      })),
      action: vi.fn(),
    }
    return { client, live }
  }

  it('opens the session of a task once, marks it ready and answers the agent’s help', async () => {
    const task = await browserTask()
    const { client } = worker()
    const sessions = new BrowserSessions({ db, client: client as never, logger: quiet })

    await sessions.ensure(task.id, new AbortController().signal)
    const [opened] = await db.browserSession.findMany({ where: { taskId: task.id } })
    expect(opened).toMatchObject({ status: 'ready', siteId: task.siteId })
    // Ids alone: the worker reads the site's address itself, the notes go to the turn's prompt.
    expect(client.ensure).toHaveBeenCalledWith(
      { sessionId: opened!.id, taskId: task.id, siteId: task.siteId, takeControl: true },
      expect.anything(),
    )

    // The next pass finds the same session; the help the agent asked for is answered by it.
    await recordBrowserHelp(db, { sessionId: opened!.id, reason: 'login', message: 'Войдите' })
    await sessions.ensure(task.id, new AbortController().signal)
    const again = await db.browserSession.findMany({ where: { taskId: task.id } })
    expect(again).toHaveLength(1)
    expect(again[0]).toMatchObject({ helpReason: null, helpMessage: null })
  })

  it('closes the session with its task, in the database and on the worker', async () => {
    const task = await browserTask()
    const { client, live } = worker()
    const sessions = new BrowserSessions({ db, client: client as never, logger: quiet })
    await sessions.ensure(task.id, new AbortController().signal)

    await sessions.close(task.id, 'task_done')

    const [closed] = await db.browserSession.findMany({ where: { taskId: task.id } })
    expect(closed).toMatchObject({ status: 'closed', closeReason: 'task_done' })
    expect(live.size).toBe(0)
  })

  it('collects the sessions of ended tasks, those the worker lost, and its orphans', async () => {
    const ended = await browserTask()
    const lost = await browserTask()
    const { client, live } = worker()
    const sessions = new BrowserSessions({
      db,
      client: client as never,
      logger: quiet,
      // Past the grace a session that is still starting may take.
      now: () => new Date(Date.now() + BROWSER_ENSURE_GRACE_MS + 60_000),
    })
    await sessions.ensure(ended.id, new AbortController().signal)
    const gone = await openBrowserSession(db, { taskId: lost.id })
    await db.task.update({ where: { id: ended.id }, data: { status: 'done' } })
    live.add('0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a99')

    expect(await sessions.sweep()).toEqual({ closed: 1, lost: 1, orphaned: 1 })

    expect(await db.browserSession.findFirst({ where: { taskId: ended.id } })).toMatchObject({
      status: 'closed',
      closeReason: 'task_done',
    })
    expect(await db.browserSession.findUnique({ where: { id: gone.id } })).toMatchObject({
      status: 'lost',
      closeReason: 'crashed',
    })
    expect(client.close).toHaveBeenCalledWith('0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a99', {
      reason: 'orphaned',
    })
    expect(live.size).toBe(0)
  })
})
