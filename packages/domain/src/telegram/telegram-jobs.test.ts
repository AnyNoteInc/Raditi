import { describe, expect, it } from 'vitest'

import { telegramDeliverDedupeKey, telegramDeliverJobSchema } from './telegram-jobs.ts'

const TASK = '019a8f00-0000-7000-8000-000000000001'

describe('the delivery of the rows of a chat to Telegram (docs/plan/80-telegram.md)', () => {
  it('keys a pass by its turn, and a row told alone by the row (docs/plan/82, Зп35)', () => {
    const pass = { taskId: TASK, kind: 'answered' as const, attempt: 1, turnNo: 2 }
    expect(telegramDeliverDedupeKey(pass)).toBe(`telegram.deliver:${TASK}:1:2:answered`)
    expect(telegramDeliverDedupeKey({ ...pass, eventId: '31' })).toBe(
      `telegram.deliver:${TASK}:event:31`,
    )
  })

  it('takes the id of a row as the database keeps it, never anything else', () => {
    const pass = { taskId: TASK, kind: 'answered', attempt: 1, turnNo: 2 }
    expect(
      telegramDeliverJobSchema.safeParse({ ...pass, eventId: '9007199254740993' }).success,
    ).toBe(true)
    for (const eventId of ['0', '-1', '1.5', '', 'x', '1'.repeat(20)])
      expect(telegramDeliverJobSchema.safeParse({ ...pass, eventId }).success, eventId).toBe(false)
  })
})
