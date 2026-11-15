import { Logger } from '@nestjs/common'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ScheduleStart, ScheduleStartRetry, SCHEDULE_INTAKE_TIMEOUT_MS } from './schedule-start.ts'

// The SQL of the runs is @repo/db's own (tested there on PostgreSQL); here only what core does
// with what web answers (docs/plan/82-scheduled-tasks.md, §4.3, Зп21).
const helpers = vi.hoisted(() => ({ recordRunOutcome: vi.fn() }))
vi.mock('@repo/db', () => helpers)

const RUN = '01900000-0000-7000-8000-000000000001'
const CHAT = '01900000-0000-7000-8000-000000000002'
const SECRET = 's'.repeat(48)
const URL_ = 'https://raditi.example/api/webhooks/scheduled-runs'
const NOW = new Date('2026-11-16T09:00:00.000Z')

beforeAll(() => {
  Logger.overrideLogger(false)
})
beforeEach(() => {
  helpers.recordRunOutcome.mockReset()
  helpers.recordRunOutcome.mockResolvedValue({ recorded: true, paused: null })
})

function stand(answer: () => Promise<Response> | Response, status = 'pending') {
  const db = {
    $transaction: vi.fn(),
    scheduledRun: {
      findUnique: vi.fn(async () => (status === 'gone' ? null : { status })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  }
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => answer())
  const notify = { afterRun: vi.fn(async () => 'sent' as const) }
  const start = new ScheduleStart({
    db: db as never,
    intake: { url: URL_, secret: SECRET },
    notify,
    fetch: fetch as unknown as typeof globalThis.fetch,
    now: () => NOW,
  })
  return { db, fetch, notify, start }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const first = { made: 0, max: 8 }
const last = { made: 7, max: 8 }

describe('ScheduleStart', () => {
  it('posts the id of the run alone, with the secret in its header and a minute to answer', async () => {
    const s = stand(() => json({ outcome: 'started', taskId: CHAT }))
    expect(await s.start.run({ runId: RUN }, first)).toBe('started')
    const [url, init] = s.fetch.mock.calls[0]!
    expect(url).toBe(URL_)
    expect(init?.method).toBe('POST')
    expect(init?.headers).toEqual({
      'content-type': 'application/json',
      'x-raditi-schedule-secret': SECRET,
    })
    expect(JSON.parse(String(init?.body))).toEqual({ runId: RUN })
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(SCHEDULE_INTAKE_TIMEOUT_MS).toBe(60_000)
    // Each delivery is counted on the run; a chat that started tells nothing here.
    expect(s.db.scheduledRun.updateMany).toHaveBeenCalledWith({
      where: { id: RUN, status: 'pending' },
      data: { attempts: { increment: 1 } },
    })
    expect(s.notify.afterRun).not.toHaveBeenCalled()
    expect(helpers.recordRunOutcome).not.toHaveBeenCalled()
  })

  it('tells a refusal and a missed run web wrote, and records nothing itself', async () => {
    const refused = stand(() => json({ outcome: 'refused', reason: 'no_credits' }))
    expect(await refused.start.run({ runId: RUN }, first)).toBe('refused')
    expect(refused.notify.afterRun).toHaveBeenCalledWith(RUN)
    const skipped = stand(() => json({ outcome: 'skipped', reason: 'missed' }))
    expect(await skipped.start.run({ runId: RUN }, first)).toBe('skipped')
    expect(skipped.notify.afterRun).toHaveBeenCalledWith(RUN)
    expect(helpers.recordRunOutcome).not.toHaveBeenCalled()
  })

  it('posts nothing for a run that is gone or was answered before', async () => {
    const gone = stand(() => json({}), 'gone')
    expect(await gone.start.run({ runId: RUN }, first)).toBe('gone')
    const answered = stand(() => json({}), 'started')
    expect(await answered.start.run({ runId: RUN }, first)).toBe('answered')
    expect(gone.fetch).not.toHaveBeenCalled()
    expect(answered.fetch).not.toHaveBeenCalled()
  })

  it.each([400, 413])('gives the run up at once on %s: web will never read it', async (status) => {
    const s = stand(() => new Response('no', { status }))
    expect(await s.start.run({ runId: RUN }, first)).toBe('given_up')
    expect(helpers.recordRunOutcome).toHaveBeenCalledWith(
      s.db,
      RUN,
      { status: 'refused', reason: 'platform' },
      NOW,
    )
    expect(s.notify.afterRun).toHaveBeenCalledWith(RUN, { recorded: true, paused: null })
  })

  it.each([
    ['401', () => new Response('', { status: 401 })],
    ['404', () => new Response('', { status: 404 })],
    ['503', () => new Response('', { status: 503 })],
    ['a body web never writes', () => json({ outcome: 'started' })],
    ['a broken connection', () => Promise.reject(new TypeError('fetch failed'))],
  ])('throws for a retry on %s, and gives the run up after the last attempt', async (_, answer) => {
    const s = stand(answer)
    await expect(s.start.run({ runId: RUN }, first)).rejects.toBeInstanceOf(ScheduleStartRetry)
    expect(helpers.recordRunOutcome).not.toHaveBeenCalled()
    expect(await s.start.run({ runId: RUN }, last)).toBe('given_up')
    expect(helpers.recordRunOutcome).toHaveBeenCalledOnce()
    expect(s.notify.afterRun).toHaveBeenCalledOnce()
  })

  it('tells nothing of a run another hand closed before it gave up', async () => {
    helpers.recordRunOutcome.mockResolvedValue({ recorded: false, paused: null })
    const s = stand(() => new Response('', { status: 500 }))
    expect(await s.start.run({ runId: RUN }, last)).toBe('given_up')
    expect(s.notify.afterRun).not.toHaveBeenCalled()
  })

  it('leaves the run to the next core when the worker closes, even at the last attempt', async () => {
    const controller = new AbortController()
    const s = stand(() => {
      controller.abort()
      return Promise.reject(new DOMException('aborted', 'AbortError'))
    })
    await expect(s.start.run({ runId: RUN }, last, controller.signal)).rejects.toBeInstanceOf(
      ScheduleStartRetry,
    )
    expect(helpers.recordRunOutcome).not.toHaveBeenCalled()
  })
})
