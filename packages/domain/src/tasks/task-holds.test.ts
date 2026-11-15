import { describe, expect, it } from 'vitest'

import { taskHoldExpiry, taskHoldHours } from './task-holds.ts'

describe('the life of the reserve of a dialog', () => {
  const now = new Date('2026-10-17T12:00:00.000Z')

  it('outlives a waiting dialog by three days', () => {
    expect(taskHoldHours.waiting).toBe(72)
    expect(taskHoldExpiry(now, 'waiting')).toEqual(new Date('2026-10-20T12:00:00.000Z'))
  })
})
