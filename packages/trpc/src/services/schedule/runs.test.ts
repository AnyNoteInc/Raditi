import { DomainError } from '@repo/domain'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { refusalReasonOf, scheduledChatId } from './runs.ts'

const error = (code: string, status: number, details?: Record<string, unknown>) =>
  new DomainError(code, 'English text for the logs', status, details)

describe('why createDialog refused the chat of a run (docs/plan/82, §4.3)', () => {
  it('maps the refusals of credits and tariffs to the reasons of the client', () => {
    expect(refusalReasonOf(error('BILLING_NOT_ENOUGH_CREDITS', 402))).toBe('no_credits')
    expect(refusalReasonOf(error('BILLING_TASK_NEEDS_SUBSCRIPTION', 402))).toBe('needs_tariff')
    expect(refusalReasonOf(error('BILLING_CREDITS_HELD', 409))).toBe('credits_held')
    expect(refusalReasonOf(error('BILLING_WINDOW_LIMIT_REACHED', 429))).toBe('weekly_limit')
    expect(refusalReasonOf(error('BILLING_DAILY_LIMIT_REACHED', 429))).toBe('daily_limit')
  })

  it('maps a project that takes no chat by the reason of the refusal', () => {
    for (const reason of ['site_not_active', 'not_synthetic'])
      expect(refusalReasonOf(error('TASK_NOT_ACCEPTED', 409, { reason }))).toBe(
        'project_unavailable',
      )
    for (const reason of ['class_unavailable', 'browser_unavailable', 'browser_insecure', 'x'])
      expect(refusalReasonOf(error('TASK_NOT_ACCEPTED', 409, { reason }))).toBe('platform')
    expect(refusalReasonOf(error('TASK_NOT_ACCEPTED', 409))).toBe('platform')
  })

  it('tells refused words, the platform and a failure that may pass apart', () => {
    for (const code of ['TASK_TEXT_EMPTY', 'TASK_TEXT_TOO_LONG', 'TASK_TEXT_HAS_SECRET'])
      expect(refusalReasonOf(error(code, 400))).toBe('text_refused')
    expect(refusalReasonOf(error('BILLING_CREDIT_RATE_MISSING', 503))).toBe('platform')
    // A project that is gone is read from the database before; NOT_FOUND is never it.
    expect(refusalReasonOf(error('NOT_FOUND', 404))).toBe('platform')
    expect(refusalReasonOf(error('CONFLICT', 409))).toBe('platform')
    expect(refusalReasonOf(error('WORKSPACE_KEY_UNAVAILABLE', 503))).toBe('retry')
    expect(refusalReasonOf(error('CHAT_NOT_CONFIGURED', 503))).toBe('retry')
    expect(refusalReasonOf(new Error('the database went away'))).toBe('retry')
  })
})

describe('the id of the chat of a run', () => {
  it('is a UUID of version 7, the same for every delivery of the run (Зп20)', () => {
    const run = {
      id: '0199a3f2-0000-7000-8000-0000000000a1',
      dueAt: new Date('2026-11-16T06:00:00Z'),
    }
    const id = scheduledChatId(run)
    expect(z.uuid({ version: 'v7' }).safeParse(id).success).toBe(true)
    expect(scheduledChatId({ ...run })).toBe(id)
    expect(scheduledChatId({ ...run, dueAt: new Date('2026-11-17T06:00:00Z') })).not.toBe(id)
  })
})
