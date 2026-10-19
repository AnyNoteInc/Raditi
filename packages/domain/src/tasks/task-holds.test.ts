import { describe, expect, it } from 'vitest'

import { previewDefaults } from '../preview/preview-config.ts'
import { taskHoldExpiry, taskHoldHours } from './task-holds.ts'

describe('the life of the reserve of a dialog', () => {
  const now = new Date('2026-10-17T12:00:00.000Z')

  it('outlives a waiting dialog as long as its unviewed preview, and a release for a day', () => {
    expect(taskHoldHours.waiting).toBe(previewDefaults.ttlHours)
    expect(taskHoldExpiry(now, 'waiting')).toEqual(new Date('2026-10-20T12:00:00.000Z'))
    expect(taskHoldExpiry(now, 'release')).toEqual(new Date('2026-10-18T12:00:00.000Z'))
  })
})
