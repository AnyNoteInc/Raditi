import { DomainError, type BrowserSessionState } from '@repo/domain'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  BROWSER_ENSURE_GRACE_MS,
  BrowserSessions,
  ENSURE_RETRY_PAUSES_MS,
  closeReasonOfTask,
} from './browser-sessions.ts'

// The database helpers are @repo/db's own (their SQL is tested there and on PostgreSQL in
// pass-settlement.integration.test.ts); here only what core decides with them.
const db = vi.hoisted(() => ({
  openBrowserSession: vi.fn(),
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

function given(options: { maxHours?: number } = {}) {
  const prisma = {
    task: {
      findUnique: vi.fn(async (_query: object) => ({ siteId: SITE })),
      findMany: vi.fn(async () => [] as Array<{ id: string; status: string }>),
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
  db.openBrowserSession.mockResolvedValue({ id: SESSION, taskId: TASK })
  db.openBrowserSessionOfTask.mockResolvedValue({ id: SESSION, taskId: TASK })
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

afterEach(() => {
  vi.resetAllMocks()
})

describe('BrowserSessions.ensure', () => {
  it('opens the session of the task, gives the browser back to the agent and clears its help', async () => {
    const g = given()
    const signal = new AbortController().signal
    await g.sessions.ensure(TASK, signal)
    expect(db.openBrowserSession).toHaveBeenCalledWith(g.prisma, { taskId: TASK })
    // Ids alone: the worker reads the site's address from the database, the agent gets the
    // site's notes in the prompt of its turn.
    expect(g.client.ensure).toHaveBeenCalledExactlyOnceWith(
      { sessionId: SESSION, taskId: TASK, siteId: SITE, takeControl: true },
      { signal },
    )
    expect(g.prisma.task.findUnique).toHaveBeenCalledWith({
      where: { id: TASK },
      select: { siteId: true },
    })
    expect(db.markBrowserSessionReady).toHaveBeenCalledWith(g.prisma, { sessionId: SESSION })
    expect(db.clearBrowserHelp).toHaveBeenCalledWith(g.prisma, { sessionId: SESSION })
  })

  it('marks a starting browser ready only later', async () => {
    const g = given()
    g.client.ensure.mockResolvedValue(state({ status: 'starting' }))
    await g.sessions.ensure(TASK, new AbortController().signal)
    expect(db.markBrowserSessionReady).not.toHaveBeenCalled()
  })

  it.each([
    [
      'a refusal of the worker',
      (g: ReturnType<typeof given>) =>
        g.client.ensure.mockRejectedValue(
          new DomainError('BROWSER_SESSION_UNAVAILABLE', 'http://10.0.0.5:8086 refused', 503),
        ),
    ],
    [
      'a session the worker no longer holds',
      (g: ReturnType<typeof given>) => g.client.ensure.mockResolvedValue(state({ status: 'lost' })),
    ],
    [
      'a refusal of the database',
      () =>
        db.openBrowserSession.mockRejectedValue(new DomainError('CONFLICT', 'site closed', 409)),
    ],
    [
      'a task that is gone',
      (g: ReturnType<typeof given>) => g.prisma.task.findUnique.mockResolvedValue(null as never),
    ],
  ])('refuses %s as unavailable, logging its code only', async (_case, fail) => {
    const g = given()
    fail(g)
    await expect(g.sessions.ensure(TASK, new AbortController().signal)).rejects.toMatchObject({
      code: 'BROWSER_SESSION_UNAVAILABLE',
    })
    expect(db.clearBrowserHelp).not.toHaveBeenCalled()
    expect(g.logger.warn).toHaveBeenCalledOnce()
    expect(JSON.stringify(g.logger.warn.mock.calls)).not.toMatch(/10\.0\.0\.5|site closed/)
  })

  it('opens the session with the deadline of the worker’s setting', async () => {
    const g = given({ maxHours: 8 })
    await g.sessions.ensure(TASK, new AbortController().signal)
    expect(db.openBrowserSession).toHaveBeenCalledWith(g.prisma, { taskId: TASK, maxHours: 8 })
  })

  it('replaces once a session the worker lost with its restart, and the pass goes on', async () => {
    const g = given()
    db.openBrowserSession
      .mockResolvedValueOnce({ id: SESSION, taskId: TASK })
      .mockResolvedValueOnce({ id: OTHER, taskId: TASK })
    // The worker closed the first row `lost` (WORKER_RESTARTED) and refused it.
    db.openBrowserSessionOfTask.mockResolvedValueOnce(null)
    g.client.ensure
      .mockRejectedValueOnce(new DomainError('BROWSER_SESSION_UNAVAILABLE', 'restarted', 503))
      .mockResolvedValueOnce(state({ session: OTHER }))
    await g.sessions.ensure(TASK, new AbortController().signal)
    expect(
      g.client.ensure.mock.calls.map(([request]) => (request as { sessionId: string }).sessionId),
    ).toEqual([SESSION, OTHER])
    expect(db.markBrowserSessionReady).toHaveBeenCalledExactlyOnceWith(g.prisma, {
      sessionId: OTHER,
    })
    expect(db.clearBrowserHelp).toHaveBeenCalledExactlyOnceWith(g.prisma, { sessionId: OTHER })
  })

  it('replaces a lost session only once: a second refusal fails the pass', async () => {
    const g = given()
    db.openBrowserSession
      .mockResolvedValueOnce({ id: SESSION, taskId: TASK })
      .mockResolvedValueOnce({ id: OTHER, taskId: TASK })
    db.openBrowserSessionOfTask.mockResolvedValue(null)
    g.client.ensure.mockRejectedValue(new DomainError('BROWSER_SESSION_UNAVAILABLE', 'down', 503))
    await expect(g.sessions.ensure(TASK, new AbortController().signal)).rejects.toMatchObject({
      code: 'BROWSER_SESSION_UNAVAILABLE',
    })
    expect(g.client.ensure).toHaveBeenCalledTimes(2)
    expect(db.clearBrowserHelp).not.toHaveBeenCalled()
  })

  it.each([
    ['did not answer', 'unreachable', undefined],
    ['answered an error of no code of its own', 'status', 502],
    ['refused while it stops or is full', 'refused', 503],
  ])(
    'asks again for the same session when the worker %s, and the pass goes on',
    async (_case, failure, status) => {
      // The worker restarts while the client answers: one request finds nobody there.
      const g = given()
      g.client.ensure.mockRejectedValueOnce(workerFailure(failure, status))
      await g.sessions.ensure(TASK, new AbortController().signal)
      expect(
        g.client.ensure.mock.calls.map(([request]) => (request as { sessionId: string }).sessionId),
      ).toEqual([SESSION, SESSION])
      expect(pauses()).toEqual([ENSURE_RETRY_PAUSES_MS[0]])
      expect(db.openBrowserSession).toHaveBeenCalledTimes(2)
      expect(db.markBrowserSessionReady).toHaveBeenCalledExactlyOnceWith(g.prisma, {
        sessionId: SESSION,
      })
      expect(db.clearBrowserHelp).toHaveBeenCalledExactlyOnceWith(g.prisma, { sessionId: SESSION })
      expect(g.logger.warn).toHaveBeenCalledExactlyOnceWith(
        `browser_ensure_retried task=${TASK} cause=BROWSER_SESSION_UNAVAILABLE`,
      )
    },
  )

  it('gives a worker that keeps silent about 45 s, then fails the pass', async () => {
    const g = given()
    g.client.ensure.mockRejectedValue(workerFailure('unreachable'))
    await expect(g.sessions.ensure(TASK, new AbortController().signal)).rejects.toMatchObject({
      code: 'BROWSER_SESSION_UNAVAILABLE',
    })
    expect(g.client.ensure).toHaveBeenCalledTimes(4)
    expect(pauses()).toEqual([...ENSURE_RETRY_PAUSES_MS])
    expect(pauses().reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(45_000)
    expect(db.clearBrowserHelp).not.toHaveBeenCalled()
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
    await expect(g.sessions.ensure(TASK, new AbortController().signal)).rejects.toMatchObject({
      code: 'BROWSER_SESSION_UNAVAILABLE',
    })
    expect(g.client.ensure).toHaveBeenCalledOnce()
    expect(timers.setTimeout).not.toHaveBeenCalled()
  })

  it('rejects with the caller’s own reason when the pass is cancelled during a pause', async () => {
    const g = given()
    const cancel = new AbortController()
    const reason = new Error('cancelled by the client')
    g.client.ensure.mockRejectedValue(workerFailure('unreachable'))
    timers.setTimeout.mockImplementation(async (_ms, _value, options) => {
      cancel.abort(reason)
      expect(options?.signal).toBe(cancel.signal)
      throw new DOMException('The operation was aborted', 'AbortError')
    })
    await expect(g.sessions.ensure(TASK, cancel.signal)).rejects.toBe(reason)
    expect(g.client.ensure).toHaveBeenCalledOnce()
  })

  it('rejects with the caller’s own reason when the pass was cancelled', async () => {
    const g = given()
    const cancel = new AbortController()
    const reason = new Error('cancelled by the client')
    g.client.ensure.mockImplementation(async () => {
      cancel.abort(reason)
      throw reason
    })
    await expect(g.sessions.ensure(TASK, cancel.signal)).rejects.toBe(reason)
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
