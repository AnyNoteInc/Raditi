import { DomainError, type BrowserSessionState } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BROWSER_ENSURE_GRACE_MS,
  BROWSER_START_FAILED,
  BrowserSessions,
  ENSURE_RETRY_PAUSES_MS,
  closeReasonOfTask,
} from './browser-sessions.ts'

// The database helpers are @repo/db's own (their SQL is tested there and on PostgreSQL in
// pass-settlement.integration.test.ts); here only what core decides with them.
const db = vi.hoisted(() => ({
  openBrowserSessionOfTask: vi.fn(),
  listOpenBrowserSessions: vi.fn(),
  markBrowserSessionReady: vi.fn(),
  clearBrowserHelp: vi.fn(),
  closeBrowserSession: vi.fn(),
}))
vi.mock('@repo/db', () => db)
// The pauses between two asks for the same session: recorded, not waited for.
const timers = vi.hoisted(() => ({
  setTimeout:
    vi.fn<(ms: number, value?: unknown, options?: { signal?: AbortSignal }) => Promise<void>>(),
}))
vi.mock('node:timers/promises', () => timers)

const TASK = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a60'
const SITE = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a61'
const SESSION = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a63'
const OTHER = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a64'
const NOW = new Date('2026-10-23T10:00:00.000Z')

const state = (patch: Partial<BrowserSessionState> = {}): BrowserSessionState => ({
  session: SESSION,
  status: 'ready',
  controller: 'agent',
  controlEpoch: 2,
  manualReady: false,
  holder: null,
  pageId: 1,
  viewportVersion: 1,
  viewport: { width: 1280, height: 800 },
  url: 'https://example.ru/wp-admin/edit.php',
  title: 'Записи',
  tabs: [],
  ...patch,
})

function given(
  options: {
    signIn?: (siteId: string) => Promise<{ login: string; password: string } | null>
  } = {},
) {
  const prisma = {
    task: {
      findUnique: vi.fn(async (_query: object) => ({ siteId: SITE })),
      findMany: vi.fn(async () => [] as Array<{ id: string; status: string }>),
    },
    browserSession: {
      findUnique: vi.fn(
        async (_query: object): Promise<{ taskId: string; status: string } | null> => ({
          taskId: TASK,
          status: 'starting',
        }),
      ),
    },
  }
  const client = {
    ensure: vi.fn(async (_request: object, _options?: object) => state()),
    close: vi.fn(async (sessionId: string) => ({ sessionId, status: 'closed' as const })),
    verify: vi.fn(async () => ({ checkpoints: [] })),
    list: vi.fn(async () => ({
      sessions: [] as Array<{ sessionId: string; taskId: string; status: 'ready' | 'closed' }>,
    })),
    action: vi.fn(),
  }
  const logger = { log: vi.fn(), warn: vi.fn() }
  const sessions = new BrowserSessions({
    db: prisma as never,
    client: client as never,
    ...options,
    logger,
    now: () => NOW,
  })
  db.openBrowserSessionOfTask.mockResolvedValue({ id: SESSION, taskId: TASK, status: 'starting' })
  db.markBrowserSessionReady.mockResolvedValue(true)
  db.clearBrowserHelp.mockResolvedValue(true)
  db.closeBrowserSession.mockResolvedValue(null)
  db.listOpenBrowserSessions.mockResolvedValue([])
  timers.setTimeout.mockResolvedValue(undefined)
  return { prisma, client, logger, sessions }
}

/** What the worker client throws when the worker did not answer as the contract says. */
const workerFailure = (failure: string, status?: number) =>
  new DomainError('BROWSER_SESSION_UNAVAILABLE', 'http://10.0.0.5:8086 failed', status ?? 503, {
    operation: 'ensure',
    failure,
    ...(status === undefined ? {} : { status }),
  })
const pauses = () => timers.setTimeout.mock.calls.map(([ms]) => ms)
/** core keeps running: nothing stops a start. */
const running = new AbortController().signal

afterEach(() => {
  vi.resetAllMocks()
})

describe('BrowserSessions.start', () => {
  const job = { taskId: TASK, sessionId: SESSION }

  it('starts the session of the job for the agent, without taking the browser from anyone', async () => {
    const g = given()
    await g.sessions.start(job, running)
    // Ids alone: the worker reads the site's address from the database, the agent gets the
    // site's notes in the prompt of its turn.
    expect(g.client.ensure).toHaveBeenCalledExactlyOnceWith(
      {
        sessionId: SESSION,
        taskId: TASK,
        siteId: SITE,
        takeControl: false,
      },
      { signal: running },
    )
    expect(db.markBrowserSessionReady).toHaveBeenCalledWith(g.prisma, { sessionId: SESSION })
    expect(db.clearBrowserHelp).not.toHaveBeenCalled()
    expect(db.closeBrowserSession).not.toHaveBeenCalled()
  })

  it('asks for the browser of a chat without a site, with no site and no sign-in', async () => {
    const signIn = vi.fn(async () => null)
    const g = given({ signIn })
    g.prisma.task.findUnique.mockResolvedValue({ siteId: null } as never)
    await g.sessions.start(job, running)
    expect(g.client.ensure).toHaveBeenCalledExactlyOnceWith(
      { sessionId: SESSION, taskId: TASK, siteId: null, takeControl: false },
      { signal: running },
    )
    expect(signIn).not.toHaveBeenCalled()
    expect(db.closeBrowserSession).not.toHaveBeenCalled()
  })

  it('leaves a late job alone: the client in the middle of signing in stays there', async () => {
    const g = given()
    g.prisma.browserSession.findUnique.mockResolvedValue({ taskId: TASK, status: 'ready' })
    await g.sessions.start(job, running)
    expect(g.client.ensure).not.toHaveBeenCalled()
    expect(db.clearBrowserHelp).not.toHaveBeenCalled()
  })

  it.each([
    ['closed', { taskId: TASK, status: 'closed' }],
    ['of another task', { taskId: SITE, status: 'starting' }],
    ['gone', null],
  ])('starts nothing for a session that is %s', async (_case, row) => {
    const g = given()
    g.prisma.browserSession.findUnique.mockResolvedValue(row as never)
    await g.sessions.start(job, running)
    expect(g.client.ensure).not.toHaveBeenCalled()
    expect(db.closeBrowserSession).not.toHaveBeenCalled()
  })

  it('gives the worker the site’s saved sign-in (Б36)', async () => {
    const saved = { login: 'admin', password: 'Пароль-сайта-2026' }
    const signIn = vi.fn(async (_siteId: string) => saved)
    const g = given({ signIn })
    await g.sessions.start(job, running)
    expect(signIn).toHaveBeenCalledExactlyOnceWith(SITE)
    expect(g.client.ensure.mock.calls[0]?.[0]).toMatchObject({ takeControl: false, signIn: saved })
  })

  it('leaves out a saved sign-in it cannot read: the client signs in by hand', async () => {
    const g = given({
      signIn: async () => {
        throw new DomainError('UNAVAILABLE', 'vault sealed: Пароль-сайта-2026', 503)
      },
    })
    await g.sessions.start(job, running)
    expect(g.client.ensure.mock.calls[0]?.[0]).not.toHaveProperty('signIn')
    expect(g.logger.warn).toHaveBeenCalledExactlyOnceWith(
      `browser_sign_in_unread site=${SITE} cause=UNAVAILABLE`,
    )
  })

  it('leaves a session still starting on the worker for the job that started it', async () => {
    const g = given()
    g.client.ensure.mockResolvedValue(state({ status: 'starting' }))
    await g.sessions.start(job, running)
    expect(db.markBrowserSessionReady).not.toHaveBeenCalled()
    expect(db.closeBrowserSession).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a refusal of the worker',
      (g: ReturnType<typeof given>) =>
        g.client.ensure.mockRejectedValue(
          new DomainError('CONFLICT', 'http://10.0.0.5:8086 refused', 409),
        ),
    ],
    [
      'a session the worker no longer holds',
      (g: ReturnType<typeof given>) => g.client.ensure.mockResolvedValue(state({ status: 'lost' })),
    ],
    [
      'a task that is gone',
      (g: ReturnType<typeof given>) => g.prisma.task.findUnique.mockResolvedValue(null as never),
    ],
  ])('closes the session `failed` after %s, logging its code only', async (_case, fail) => {
    const g = given()
    fail(g)
    await g.sessions.start(job, running)
    expect(db.closeBrowserSession).toHaveBeenCalledExactlyOnceWith(g.prisma, {
      sessionId: SESSION,
      status: 'failed',
      reason: 'crashed',
      errorCode: BROWSER_START_FAILED,
      onlyStarting: true,
    })
    expect(JSON.stringify(g.logger.warn.mock.calls)).not.toMatch(/10\.0\.0\.5/)
  })

  it('leaves a browser that came up though the worker’s answer was lost', async () => {
    const g = given()
    db.openBrowserSessionOfTask.mockResolvedValue({ id: SESSION, taskId: TASK, status: 'ready' })
    g.client.ensure.mockRejectedValue(workerFailure('timeout'))
    await g.sessions.start(job, running)
    expect(g.client.ensure).toHaveBeenCalledOnce()
    expect(timers.setTimeout).not.toHaveBeenCalled()
    expect(db.closeBrowserSession).not.toHaveBeenCalled()
  })

  it('gives the shutdown of core to the worker’s client and to its pauses', async () => {
    const g = given()
    const shutdown = new AbortController()
    g.client.ensure.mockRejectedValueOnce(workerFailure('unreachable'))
    await g.sessions.start(job, shutdown.signal)
    expect(g.client.ensure).toHaveBeenLastCalledWith(expect.anything(), {
      signal: shutdown.signal,
    })
    expect(timers.setTimeout).toHaveBeenCalledWith(ENSURE_RETRY_PAUSES_MS[0], undefined, {
      signal: shutdown.signal,
    })
  })

  it('leaves the row open when core stops during the worker’s answer', async () => {
    const g = given()
    const shutdown = new AbortController()
    g.client.ensure.mockImplementationOnce(async () => {
      shutdown.abort()
      throw new DOMException('stopped', 'AbortError')
    })
    await g.sessions.start(job, shutdown.signal)
    expect(g.client.ensure).toHaveBeenCalledOnce()
    expect(db.closeBrowserSession).not.toHaveBeenCalled()
  })

  it('leaves the row open when core stops during a pause', async () => {
    const g = given()
    const shutdown = new AbortController()
    g.client.ensure.mockRejectedValue(workerFailure('unreachable'))
    timers.setTimeout.mockImplementationOnce(async () => {
      shutdown.abort()
      throw new DOMException('stopped', 'AbortError')
    })
    await g.sessions.start(job, shutdown.signal)
    expect(g.client.ensure).toHaveBeenCalledOnce()
    expect(db.closeBrowserSession).not.toHaveBeenCalled()
  })

  it('stops when the row closed meanwhile: the worker said so, or the task ended', async () => {
    const g = given()
    db.openBrowserSessionOfTask.mockResolvedValue(null)
    g.client.ensure.mockRejectedValue(new DomainError('BROWSER_SESSION_UNAVAILABLE', 'down', 503))
    await g.sessions.start(job, running)
    expect(g.client.ensure).toHaveBeenCalledOnce()
    expect(db.closeBrowserSession).not.toHaveBeenCalled()
  })

  it.each([
    ['did not answer', 'unreachable', undefined],
    ['answered an error of no code of its own', 'status', 502],
    ['refused while it stops or is full', 'refused', 503],
  ])('asks again for the same session when the worker %s', async (_case, failure, status) => {
    const g = given()
    g.client.ensure.mockRejectedValueOnce(workerFailure(failure, status))
    await g.sessions.start(job, running)
    expect(g.client.ensure).toHaveBeenCalledTimes(2)
    expect(pauses()).toEqual([ENSURE_RETRY_PAUSES_MS[0]])
    expect(db.markBrowserSessionReady).toHaveBeenCalledExactlyOnceWith(g.prisma, {
      sessionId: SESSION,
    })
    expect(g.logger.warn).toHaveBeenCalledExactlyOnceWith(
      `browser_ensure_retried task=${TASK} cause=BROWSER_SESSION_UNAVAILABLE`,
    )
  })

  it('gives a worker that keeps silent about 45 s, then closes the session', async () => {
    const g = given()
    g.client.ensure.mockRejectedValue(workerFailure('unreachable'))
    await g.sessions.start(job, running)
    expect(g.client.ensure).toHaveBeenCalledTimes(4)
    expect(pauses()).toEqual([...ENSURE_RETRY_PAUSES_MS])
    expect(pauses().reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(45_000)
    expect(db.closeBrowserSession).toHaveBeenCalledOnce()
  })

  it.each([
    ['a timeout: a cold start had its whole limit', workerFailure('timeout')],
    [
      'a refusal of the worker’s own',
      new DomainError('CONFLICT', 'refused', 409, {
        operation: 'ensure',
        failure: 'refused',
        status: 409,
      }),
    ],
    ['an answer that is not the contract’s', workerFailure('body', 200)],
  ])('never asks again after %s', async (_case, error) => {
    const g = given()
    g.client.ensure.mockRejectedValue(error)
    await g.sessions.start(job, running)
    expect(g.client.ensure).toHaveBeenCalledOnce()
    expect(timers.setTimeout).not.toHaveBeenCalled()
    expect(db.closeBrowserSession).toHaveBeenCalledOnce()
  })
})

describe('BrowserSessions.reclaim', () => {
  it('gives the live browser back to the agent and answers its request for help', async () => {
    const g = given()
    const signal = new AbortController().signal
    await g.sessions.reclaim(TASK, signal)
    expect(g.client.ensure).toHaveBeenCalledExactlyOnceWith(
      { sessionId: SESSION, taskId: TASK, siteId: SITE, takeControl: true },
      { signal },
    )
    expect(db.markBrowserSessionReady).toHaveBeenCalledWith(g.prisma, { sessionId: SESSION })
    expect(db.clearBrowserHelp).toHaveBeenCalledWith(g.prisma, { sessionId: SESSION })
  })

  it('gives the browser of a chat without a site back with no site and no sign-in', async () => {
    const signIn = vi.fn(async () => null)
    const g = given({ signIn })
    db.openBrowserSessionOfTask.mockResolvedValue({ id: SESSION, status: 'ready' })
    g.prisma.task.findUnique.mockResolvedValue({ siteId: null } as never)
    await g.sessions.reclaim(TASK, running)
    expect(g.client.ensure).toHaveBeenCalledExactlyOnceWith(
      { sessionId: SESSION, taskId: TASK, siteId: null, takeControl: true },
      { signal: running },
    )
    expect(signIn).not.toHaveBeenCalled()
    expect(db.clearBrowserHelp).toHaveBeenCalledWith(g.prisma, { sessionId: SESSION })
  })

  it('starts nothing for a turn with no live browser: it may need none', async () => {
    const g = given()
    db.openBrowserSessionOfTask.mockResolvedValue(null)
    await g.sessions.reclaim(TASK, new AbortController().signal)
    expect(g.client.ensure).not.toHaveBeenCalled()
    expect(db.clearBrowserHelp).not.toHaveBeenCalled()
  })

  it('gives the worker the site’s saved sign-in with every turn (Б36)', async () => {
    const saved = { login: 'admin', password: 'Пароль-сайта-2026' }
    const g = given({ signIn: async () => saved })
    await g.sessions.reclaim(TASK, new AbortController().signal)
    expect(g.client.ensure.mock.calls[0]?.[0]).toMatchObject({ takeControl: true, signIn: saved })
  })

  it('logs a failure by its code and lets the turn go on', async () => {
    const g = given()
    g.client.ensure.mockRejectedValue(new DomainError('CONFLICT', 'http://10.0.0.5:8086', 409))
    await expect(g.sessions.reclaim(TASK, new AbortController().signal)).resolves.toBeUndefined()
    expect(g.client.ensure).toHaveBeenCalledOnce()
    expect(db.clearBrowserHelp).not.toHaveBeenCalled()
    expect(g.logger.warn).toHaveBeenCalledExactlyOnceWith(
      `browser_reclaim_failed task=${TASK} cause=CONFLICT`,
    )
  })

  it('says nothing of a turn the client cancelled meanwhile', async () => {
    const g = given()
    const cancel = new AbortController()
    g.client.ensure.mockImplementation(async () => {
      cancel.abort(new Error('cancelled by the client'))
      throw cancel.signal.reason
    })
    await g.sessions.reclaim(TASK, cancel.signal)
    expect(g.logger.warn).not.toHaveBeenCalled()
  })
})

describe('BrowserSessions.verify and close', () => {
  it('asks the worker to read the checkpoints of the live session, best effort', async () => {
    const g = given()
    expect(await g.sessions.verify(TASK)).toBe(true)
    expect(g.client.verify).toHaveBeenCalledWith(SESSION)

    g.client.verify.mockRejectedValue(new DomainError('BROWSER_TIMEOUT', 'slow', 504))
    expect(await g.sessions.verify(TASK)).toBe(false)

    db.openBrowserSessionOfTask.mockResolvedValue(null)
    g.client.verify.mockClear()
    expect(await g.sessions.verify(TASK)).toBe(false)
    expect(g.client.verify).not.toHaveBeenCalled()
  })

  it('closes in the database first, then on the worker, and never throws', async () => {
    const g = given()
    const order: string[] = []
    db.closeBrowserSession.mockImplementation(async () => {
      order.push('db')
      return null
    })
    g.client.close.mockImplementation(async () => {
      order.push('worker')
      throw new DomainError('BROWSER_SESSION_UNAVAILABLE', 'down', 503)
    })
    await expect(g.sessions.close(TASK, 'task_done')).resolves.toBeUndefined()
    expect(order).toEqual(['db', 'worker'])
    expect(db.closeBrowserSession).toHaveBeenCalledWith(g.prisma, {
      sessionId: SESSION,
      status: 'closed',
      reason: 'task_done',
    })
    expect(g.client.close).toHaveBeenCalledWith(SESSION, { reason: 'task_done' })

    db.openBrowserSessionOfTask.mockRejectedValue(new Error('database down'))
    await expect(g.sessions.close(TASK, 'task_failed')).resolves.toBeUndefined()
  })
})

describe('BrowserSessions.sweep (Б18)', () => {
  const open = (
    id: string,
    taskId: string,
    patch: { createdAt?: Date; expiresAt?: Date } = {},
  ) => ({
    id,
    taskId,
    createdAt: patch.createdAt ?? new Date(NOW.getTime() - BROWSER_ENSURE_GRACE_MS - 1),
    expiresAt: patch.expiresAt ?? new Date(NOW.getTime() + 3_600_000),
  })

  it('closes the sessions of ended tasks and past their deadline', async () => {
    const g = given()
    const ended = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a70'
    const expired = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a71'
    db.listOpenBrowserSessions.mockResolvedValue([
      open(SESSION, ended),
      open(OTHER, expired, { expiresAt: NOW }),
    ])
    g.prisma.task.findMany.mockResolvedValue([
      { id: ended, status: 'done' },
      { id: expired, status: 'awaiting_user' },
    ])
    g.client.list.mockResolvedValue({
      sessions: [
        { sessionId: SESSION, taskId: ended, status: 'ready' },
        { sessionId: OTHER, taskId: expired, status: 'ready' },
      ],
    })
    expect(await g.sessions.sweep()).toEqual({ closed: 2, lost: 0, orphaned: 0 })
    expect(g.client.close).toHaveBeenCalledWith(SESSION, { reason: 'task_done' })
    expect(g.client.close).toHaveBeenCalledWith(OTHER, { reason: 'expired' })
  })

  it('marks lost what the worker no longer holds, never a young session or one at work here', async () => {
    const g = given()
    const young = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a72'
    const busy = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a73'
    const lostTask = '0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a74'
    db.listOpenBrowserSessions.mockResolvedValue([
      open(SESSION, lostTask),
      open(OTHER, young, { createdAt: new Date(NOW.getTime() - 1_000) }),
      open('0199b2f4-6c1e-7a52-9f3d-2b8e4c7d1a75', busy),
    ])
    g.prisma.task.findMany.mockResolvedValue([
      { id: lostTask, status: 'awaiting_user' },
      { id: young, status: 'preparing' },
      { id: busy, status: 'running' },
    ])
    expect(await g.sessions.sweep({ busy: (taskId) => taskId === busy })).toEqual({
      closed: 0,
      lost: 1,
      orphaned: 0,
    })
    expect(db.closeBrowserSession).toHaveBeenCalledExactlyOnceWith(g.prisma, {
      sessionId: SESSION,
      status: 'lost',
      reason: 'crashed',
    })
    expect(g.client.close).not.toHaveBeenCalled()
  })

  it('closes on the worker what the database does not keep open, reading the worker first', async () => {
    const g = given()
    const order: string[] = []
    g.client.list.mockImplementation(async () => {
      order.push('worker')
      return { sessions: [{ sessionId: OTHER, taskId: TASK, status: 'ready' }] }
    })
    db.listOpenBrowserSessions.mockImplementation(async () => {
      order.push('database')
      return []
    })
    expect(await g.sessions.sweep()).toEqual({ closed: 0, lost: 0, orphaned: 1 })
    expect(order).toEqual(['worker', 'database'])
    expect(g.client.close).toHaveBeenCalledExactlyOnceWith(OTHER, { reason: 'orphaned' })
  })

  it('takes nothing for lost or orphaned without the worker’s list, and still closes ended tasks', async () => {
    const g = given()
    g.client.list.mockRejectedValue(new DomainError('BROWSER_SESSION_UNAVAILABLE', 'down', 503))
    db.listOpenBrowserSessions.mockResolvedValue([open(SESSION, TASK)])
    g.prisma.task.findMany.mockResolvedValue([{ id: TASK, status: 'cancelled' }])
    expect(await g.sessions.sweep()).toEqual({ closed: 1, lost: 0, orphaned: 0 })
    expect(db.closeBrowserSession).toHaveBeenCalledWith(g.prisma, {
      sessionId: SESSION,
      status: 'closed',
      reason: 'task_cancelled',
    })
  })
})

describe('closeReasonOfTask', () => {
  it('names why the session of an ended task closes, and nothing for one that goes on', () => {
    expect(closeReasonOfTask('done')).toBe('task_done')
    expect(closeReasonOfTask('failed')).toBe('task_failed')
    expect(closeReasonOfTask('rolled_back')).toBe('task_failed')
    expect(closeReasonOfTask('cancelled')).toBe('task_cancelled')
    expect(closeReasonOfTask(undefined)).toBe('orphaned')
    for (const status of ['queued', 'preparing', 'running', 'awaiting_user'] as const)
      expect(closeReasonOfTask(status)).toBeNull()
  })
})
