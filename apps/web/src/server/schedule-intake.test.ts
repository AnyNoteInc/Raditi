import { SCHEDULE_INTAKE_MAX_BYTES, SCHEDULE_INTAKE_SECRET_HEADER } from '@repo/domain'
import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const { handleScheduleIntake, scheduleSecretMatches } = await import('./schedule-intake')

const SECRET = 'S'.repeat(43)
const RUN = '0199a3f2-0000-7000-8000-0000000000a1'
const CHAT = '0199a3f2-0000-7000-8000-0000000000c1'

const post = (body: string, secret: string | null = SECRET) =>
  new Request('http://web/api/webhooks/scheduled-runs', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(secret === null ? {} : { [SCHEDULE_INTAKE_SECRET_HEADER]: secret }),
    },
    body,
  })

describe('handleScheduleIntake (docs/plan/82, §4.3)', () => {
  it('hands a run to its start and answers its outcome', async () => {
    const start = vi.fn(async () => ({ outcome: 'started' as const, taskId: CHAT }))
    const response = await handleScheduleIntake(post(JSON.stringify({ runId: RUN })), {
      secret: SECRET,
      start,
    })
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.json()).toEqual({ outcome: 'started', taskId: CHAT })
    expect(start).toHaveBeenCalledWith({ runId: RUN })
  })

  it('answers refused and skipped runs with 200: core gives them no second delivery', async () => {
    for (const answer of [
      { outcome: 'refused' as const, reason: 'no_credits' as const },
      { outcome: 'skipped' as const, reason: 'paused' as const },
    ]) {
      const response = await handleScheduleIntake(post(JSON.stringify({ runId: RUN })), {
        secret: SECRET,
        start: async () => answer,
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(answer)
    }
  })

  it('takes nothing without its secret, without the header or with another secret', async () => {
    const start = vi.fn(async () => ({ outcome: 'skipped' as const, reason: 'paused' as const }))
    const body = JSON.stringify({ runId: RUN })
    expect((await handleScheduleIntake(post(body), { secret: null, start })).status).toBe(404)
    expect((await handleScheduleIntake(post(body, null), { secret: SECRET, start })).status).toBe(
      401,
    )
    expect(
      (await handleScheduleIntake(post(body, 'X'.repeat(43)), { secret: SECRET, start })).status,
    ).toBe(401)
    expect(
      (await handleScheduleIntake(post(body, `${SECRET}x`), { secret: SECRET, start })).status,
    ).toBe(401)
    expect(start).not.toHaveBeenCalled()
  })

  it('refuses for good a body over 1 KiB and what is not a run', async () => {
    const start = vi.fn(async () => ({ outcome: 'skipped' as const, reason: 'paused' as const }))
    const route = { secret: SECRET, start }
    const big = JSON.stringify({ runId: RUN, pad: 'x'.repeat(SCHEDULE_INTAKE_MAX_BYTES) })
    expect((await handleScheduleIntake(post(big), route)).status).toBe(413)
    expect((await handleScheduleIntake(post('not json'), route)).status).toBe(400)
    expect((await handleScheduleIntake(post('{"runId":"x"}'), route)).status).toBe(400)
    // Nothing but the id: a word of the task never travels.
    expect(
      (await handleScheduleIntake(post(JSON.stringify({ runId: RUN, text: 'Привет' })), route))
        .status,
    ).toBe(400)
    expect(start).not.toHaveBeenCalled()
  })

  it('answers 503 when the start fails, so core asks again, and logs no words', async () => {
    const logError = vi.fn()
    const response = await handleScheduleIntake(post(JSON.stringify({ runId: RUN })), {
      secret: SECRET,
      start: async () => {
        throw new Error('Проверьте сайт — words of the task')
      },
      logError,
    })
    expect(response.status).toBe(503)
    expect(logError).toHaveBeenCalledWith(`[schedule] run ${RUN} failed: Error`)
  })
})

describe('scheduleSecretMatches', () => {
  it('takes the exact secret alone', () => {
    expect(scheduleSecretMatches(SECRET, SECRET)).toBe(true)
    expect(scheduleSecretMatches(null, SECRET)).toBe(false)
    expect(scheduleSecretMatches('', SECRET)).toBe(false)
    expect(scheduleSecretMatches(SECRET.slice(1), SECRET)).toBe(false)
  })
})
